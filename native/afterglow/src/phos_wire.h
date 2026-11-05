/**
 * @file src/phos_wire.h
 * @brief afterglow's local link to phosphorus: its message framing and the H.264
 * reshaping done once here so phosphorus copies each frame once. Pure C++, no
 * Apollo or platform headers, so it is built and tested on its own
 * (native/afterglow/test/wire_test.cpp).
 *
 * A message: u32 little-endian length of what follows, then one type byte, then the
 * body. Frames and parameter sets go out shaped for the viewer: 8 bytes in front that
 * phosphorus overwrites with its own header (the type byte is the first of them),
 * then AVCC, length-prefixed NAL units, which is what WebCodecs takes.
 */
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace phos::wire {

  // phosphorus to afterglow
  enum class in_t : std::uint8_t {
    hello = 0x01,  // the link's token, as text
    launch = 0x02,  // json: cmd, name, w, h, fps, scale, virtual_display
    video = 0x03,  // json: gen, w, h, fps, kbps, yuv444
    stop_video = 0x04,
    idr = 0x05,
    input = 0x06,  // one GameStream input packet, as Apollo's input::passthrough takes it
    quit = 0x07,  // the app asked to close
    ping = 0x08,  // u32 echoed back
  };

  // afterglow to phosphorus
  enum class out_t : std::uint8_t {
    ready = 0x81,  // json: version, virtual_display, encoder, hostname
    launched = 0x82,  // json: ok, error, resumed
    exited = 0x83,  // json: the app is gone
    video_ended = 0x84,  // json: gen, why
    pong = 0x88,  // u32
    // every u16 little-endian; gen: the video message's, so phosphorus drops what an
    // earlier video sent after it asked for the next
    config = 0x90,  // [type][pad][u16 gen][u16 w][u16 h] then avcC
    frame = 0x91,  // [type][key][u16 gen][pad 4] then AVCC
  };

  // room in front of a frame's AVCC: the viewer's own header length
  constexpr std::size_t head_len = 8;
  // the largest message either side accepts: a 4K IDR at a high rate fits many times
  constexpr std::uint32_t max_len = 64u << 20;

  inline void put_u16(std::uint8_t *p, std::uint16_t v) {
    p[0] = v & 0xff;
    p[1] = v >> 8;
  }

  inline void put_u32(std::uint8_t *p, std::uint32_t v) {
    p[0] = v & 0xff;
    p[1] = (v >> 8) & 0xff;
    p[2] = (v >> 16) & 0xff;
    p[3] = v >> 24;
  }

  inline void put_be32(std::uint8_t *p, std::uint32_t v) {
    p[0] = v >> 24;
    p[1] = (v >> 16) & 0xff;
    p[2] = (v >> 8) & 0xff;
    p[3] = v & 0xff;
  }

  inline std::uint32_t get_u32(const std::uint8_t *p) {
    return p[0] | (p[1] << 8) | (p[2] << 16) | ((std::uint32_t) p[3] << 24);
  }

  // one whole message: length, type, body
  inline std::vector<std::uint8_t> message(std::uint8_t type, std::string_view body) {
    std::vector<std::uint8_t> out(5 + body.size());
    put_u32(out.data(), (std::uint32_t) (1 + body.size()));
    out[4] = type;
    if (!body.empty()) {
      std::memcpy(out.data() + 5, body.data(), body.size());
    }
    return out;
  }

  inline std::vector<std::uint8_t> message(out_t type, std::string_view body = {}) {
    return message((std::uint8_t) type, body);
  }

  // messages out of a byte stream as it arrives, whatever the chunking
  class reader_t {
  public:
    struct msg_t {
      std::uint8_t type;
      std::vector<std::uint8_t> body;
    };

    // false: the stream is broken (a length past max_len, or none at all)
    bool feed(const std::uint8_t *p, std::size_t n) {
      buf.insert(buf.end(), p, p + n);
      return !bad;
    }

    std::optional<msg_t> next() {
      if (bad || buf.size() - at < 4) {
        compact();
        return std::nullopt;
      }
      auto len = get_u32(buf.data() + at);
      if (len < 1 || len > max_len) {
        bad = true;
        return std::nullopt;
      }
      if (buf.size() - at < 4 + (std::size_t) len) {
        compact();
        return std::nullopt;
      }
      msg_t m;
      m.type = buf[at + 4];
      m.body.assign(buf.begin() + at + 5, buf.begin() + at + 4 + len);
      at += 4 + len;
      return m;
    }

    bool broken() const {
      return bad;
    }

  private:
    void compact() {
      if (at) {
        buf.erase(buf.begin(), buf.begin() + at);
        at = 0;
      }
    }

    std::vector<std::uint8_t> buf;
    std::size_t at = 0;
    bool bad = false;
  };

  // one NAL unit in an Annex B stream: where its bytes start (after the start code)
  // and end, its type
  struct nal_t {
    std::size_t start, end;
    std::uint8_t type;
  };

  inline std::vector<nal_t> nals_of(const std::uint8_t *b, std::size_t n) {
    std::vector<nal_t> out;
    auto find = [&](std::size_t from) -> std::size_t {
      for (std::size_t i = from; i + 3 <= n; ++i) {
        if (b[i] == 0 && b[i + 1] == 0 && b[i + 2] == 1) {
          return i;
        }
      }
      return n;
    };
    auto i = find(0);
    while (i < n) {
      auto start = i + 3;
      auto next = find(start);
      auto end = next;
      // a 4-byte start code's leading zero belongs to it, not the NAL before
      if (next < n && end > start && b[end - 1] == 0) {
        --end;
      }
      // trailing zero padding isn't the NAL's
      if (next >= n) {
        while (end > start && b[end - 1] == 0) {
          --end;
        }
      }
      if (end > start) {
        out.push_back({start, end, (std::uint8_t) (b[start] & 0x1f)});
      }
      i = next;
    }
    return out;
  }

  // an avcC record from one SPS and one PPS: what VideoDecoder takes as description
  inline std::vector<std::uint8_t> avcc_of(std::string_view sps, std::string_view pps) {
    std::vector<std::uint8_t> out(11 + sps.size() + pps.size());
    out[0] = 1;
    out[1] = sps.size() > 1 ? sps[1] : 0;
    out[2] = sps.size() > 2 ? sps[2] : 0;
    out[3] = sps.size() > 3 ? sps[3] : 0;
    out[4] = 0xff;
    out[5] = 0xe1;
    out[6] = (sps.size() >> 8) & 0xff;
    out[7] = sps.size() & 0xff;
    std::memcpy(out.data() + 8, sps.data(), sps.size());
    auto o = 8 + sps.size();
    out[o++] = 1;
    out[o++] = (pps.size() >> 8) & 0xff;
    out[o++] = pps.size() & 0xff;
    std::memcpy(out.data() + o, pps.data(), pps.size());
    return out;
  }

  // H.264 access units in, the link's messages out: parameter sets as a config
  // message whenever they change, every other NAL unit of the frame in AVCC behind
  // the viewer's header room. Access unit delimiters are dropped, nothing else
  class shaper_t {
  public:
    struct out_t_ {
      // a config message to send first, empty when the parameter sets are as before
      std::vector<std::uint8_t> config;
      // the frame message, empty when the access unit held no picture
      std::vector<std::uint8_t> frame;
    };

    // a fresh video: its first parameter sets always sent
    void reset() {
      sps.clear();
      pps.clear();
    }

    out_t_ shape(const std::uint8_t *b, std::size_t n, bool key, std::uint16_t gen, std::uint16_t w, std::uint16_t h) {
      out_t_ r;
      auto list = nals_of(b, n);
      std::size_t body = 0;
      std::string_view new_sps, new_pps;
      for (auto &u : list) {
        std::string_view v {(const char *) b + u.start, u.end - u.start};
        if (u.type == 7) {
          new_sps = v;
        } else if (u.type == 8) {
          new_pps = v;
        } else if (u.type != 9) {
          body += 4 + v.size();
        }
      }
      if (!new_sps.empty() && !new_pps.empty() && (new_sps != sps || new_pps != pps)) {
        sps.assign(new_sps);
        pps.assign(new_pps);
        auto rec = avcc_of(sps, pps);
        std::string cfg(head_len, '\0');
        cfg[0] = (char) out_t::config;
        put_u16((std::uint8_t *) cfg.data() + 2, gen);
        put_u16((std::uint8_t *) cfg.data() + 4, w);
        put_u16((std::uint8_t *) cfg.data() + 6, h);
        cfg.append((const char *) rec.data(), rec.size());
        r.config = message((std::uint8_t) cfg[0], std::string_view {cfg}.substr(1));
      }
      if (!body) {
        return r;
      }
      // [u32 len][type][key][u16 gen][pad 4][AVCC]: the type byte starts the 8 bytes of room
      r.frame.resize(4 + head_len + body);
      put_u32(r.frame.data(), (std::uint32_t) (head_len + body));
      r.frame[4] = (std::uint8_t) out_t::frame;
      r.frame[5] = key ? 1 : 0;
      put_u16(r.frame.data() + 6, gen);
      auto o = 4 + head_len;
      for (auto &u : list) {
        if (u.type == 7 || u.type == 8 || u.type == 9) {
          continue;
        }
        auto len = u.end - u.start;
        put_be32(r.frame.data() + o, (std::uint32_t) len);
        std::memcpy(r.frame.data() + o + 4, b + u.start, len);
        o += 4 + len;
      }
      return r;
    }

  private:
    std::string sps, pps;
  };

  // the token compared in constant time: a wrong guess learns nothing from timing
  inline bool same_token(std::string_view a, std::string_view b) {
    if (a.size() != b.size() || a.empty()) {
      return false;
    }
    unsigned char d = 0;
    for (std::size_t i = 0; i < a.size(); ++i) {
      d |= (unsigned char) a[i] ^ (unsigned char) b[i];
    }
    return d == 0;
  }

  // an app's command line as cmd.exe starts it, waited on so the stream follows the
  // app until it quits: a path the host's own desk listed (a .lnk, .exe, .url),
  // never anything with a quote in it
  inline std::optional<std::string> launcher_cmd(std::string_view target) {
    if (target.empty() || target.size() > 4096 || target.find('"') != std::string_view::npos) {
      return std::nullopt;
    }
    for (unsigned char c : target) {
      if (c < 0x20) {
        return std::nullopt;
      }
    }
    return std::string {"cmd.exe /d /c start \"\" /wait \""} + std::string {target} + "\"";
  }
}  // namespace phos::wire
