/**
 * @file src/phos_link.cpp
 * @brief afterglow's local link to phosphorus.
 *
 * What GameStream did between phosphorus and Apollo, done here in-process: no HTTPS
 * pairing or serverinfo, no RTSP handshake, no ENet control stream, no AES-GCM, no
 * RTP packetization or FEC on the way out and no depacketizing on the way in. Each
 * encoded frame leaves the encoder's queue, is reshaped once into the AVCC the
 * viewer's decoder takes (phos_wire.h) and written to one loopback socket; input
 * comes back on the same socket as GameStream input packets, straight into Apollo's
 * input::passthrough. No audio is captured: phosphorus's viewer plays none.
 *
 * One phosphorus at a time: a new connection that says the token takes over and the
 * old one is closed. One app at a time, kept running between connections and videos
 * so a viewer that comes back (or a resize) resumes it.
 */
#include "phos_link.h"

// standard includes
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <thread>

// lib includes
#include <boost/asio.hpp>
#include <nlohmann/json.hpp>

// local includes
#include "config.h"
#include "crypto.h"
#include "globals.h"
#include "input.h"
#include "logging.h"
#include "phos_wire.h"
#include "platform/common.h"
#include "process.h"
#include "rtsp.h"
#include "video.h"

#ifdef _WIN32
  #include "platform/windows/misc.h"
  #include "platform/windows/virtual_display.h"
#endif

using namespace std::literals;
namespace asio = boost::asio;
using asio::ip::tcp;
using json = nlohmann::json;

namespace phos {
  namespace {
    // the display phosphorus's apps get: one id, so Windows keeps its settings
    constexpr auto display_uuid = "5D1B0F7A-3C55-4E8B-9D2E-AF7E0C6B1A01";

    // one connection from phosphorus: writes from any thread, one at a time
    struct conn_t {
      explicit conn_t(tcp::socket &&s):
          sock {std::move(s)} {
      }

      bool send(const std::vector<std::uint8_t> &m) {
        if (m.empty()) {
          return true;
        }
        std::lock_guard lg {write_lock};
        if (dead) {
          return false;
        }
        boost::system::error_code ec;
        asio::write(sock, asio::buffer(m), ec);
        if (ec) {
          dead = true;
        }
        return !dead;
      }

      bool send(wire::out_t t, const json &j) {
        return send(wire::message(t, j.dump()));
      }

      void close() {
        std::lock_guard lg {write_lock};
        dead = true;
        boost::system::error_code ec;
        sock.shutdown(tcp::socket::shutdown_both, ec);
        sock.close(ec);
      }

      tcp::socket sock;
      std::mutex write_lock;
      bool dead = false;
    };

    // one run of the video: Apollo's capture and encoder on their own mail, the
    // frames pumped from the encoder's queue to the connection
    struct run_t {
      safe::mail_t mail;
      safe::mail_raw_t::event_t<bool> shutdown;
      safe::mail_raw_t::event_t<bool> idr;
      std::shared_ptr<input::input_t> input;
      std::thread capture;
      std::thread pump;
      std::atomic_bool stopping {false};
      std::atomic_bool ended {false};
      wire::shaper_t shaper;
      std::uint16_t gen = 0, w = 0, h = 0;
    };

    // an IDR's bitstream with Apollo's own fixes put in (its SPS VUI rewritten)
    std::string_view replaced(video::packet_raw_t &p, std::vector<std::uint8_t> &scratch) {
      std::string_view out {(const char *) p.data(), p.data_size()};
      if (!p.is_idr() || !p.replacements) {
        return out;
      }
      for (auto &r : *p.replacements) {
        auto at = out.find(r.old);
        if (at == std::string_view::npos) {
          continue;
        }
        std::vector<std::uint8_t> next;
        next.reserve(out.size() - r.old.size() + r._new.size());
        next.insert(next.end(), out.begin(), out.begin() + at);
        next.insert(next.end(), r._new.begin(), r._new.end());
        next.insert(next.end(), out.begin() + at + r.old.size(), out.end());
        scratch = std::move(next);
        out = {(const char *) scratch.data(), scratch.size()};
      }
      return out;
    }

    class link_t {
    public:
      link_t(std::uint16_t port, std::string token):
          port {port},
          token {std::move(token)} {
      }

      int run() {
        auto shutdown_event = mail::man->event<bool>(mail::shutdown);
        tcp::acceptor acceptor {io};
        boost::system::error_code ec;
        tcp::endpoint ep {asio::ip::make_address_v4("127.0.0.1"), port};
        acceptor.open(ep.protocol(), ec);
        if (!ec) {
          acceptor.set_option(tcp::acceptor::reuse_address(false), ec);
          acceptor.bind(ep, ec);
        }
        if (!ec) {
          acceptor.listen(4, ec);
        }
        if (ec) {
          BOOST_LOG(fatal) << "phosphorus link: can't listen on 127.0.0.1:"sv << port << ": "sv << ec.message();
          return -1;
        }
        BOOST_LOG(info) << "phosphorus link on 127.0.0.1:"sv << port;

        watcher = std::thread {[this, shutdown_event]() {
          watch(shutdown_event);
        }};
        std::thread closer {[&]() {
          shutdown_event->view();
          acceptor.close();
        }};

        while (!shutdown_event->peek()) {
          tcp::socket s {io};
          acceptor.accept(s, ec);
          if (ec) {
            if (shutdown_event->peek()) {
              break;
            }
            std::this_thread::sleep_for(100ms);
            continue;
          }
          s.set_option(tcp::no_delay(true), ec);
          // an IDR's burst whole in the kernel's buffer, never a partial write's wait
          s.set_option(asio::socket_base::send_buffer_size(8 << 20), ec);
          auto c = std::make_shared<conn_t>(std::move(s));
          std::thread {[this, c]() {
            serve(c);
          }}.detach();
        }

        closer.join();
        {
          std::lock_guard lg {lock};
          stop_video();
          if (current) {
            current->close();
          }
        }
        watcher.join();
        return 0;
      }

    private:
      // the app quit on its own: phosphorus told, the video stopped
      void watch(safe::mail_raw_t::event_t<bool> shutdown_event) {
        while (!shutdown_event->peek()) {
          std::this_thread::sleep_for(250ms);
          std::lock_guard lg {lock};
          if (video_run && video_run->ended.exchange(false) && !video_run->stopping) {
            if (current) {
              current->send(wire::out_t::video_ended, json {{"gen", video_run->gen}, {"why", "the capture ended"}});
            }
          }
          if (!launched || proc::proc.running()) {
            continue;
          }
          launched = false;
          stop_video();
          if (current) {
            current->send(wire::out_t::exited, json::object());
          }
        }
      }

      void serve(std::shared_ptr<conn_t> c) {
        wire::reader_t reader;
        bool hello = false;
        std::array<std::uint8_t, 64 << 10> buf;
        for (;;) {
          boost::system::error_code ec;
          auto n = c->sock.read_some(asio::buffer(buf), ec);
          if (ec || !reader.feed(buf.data(), n)) {
            break;
          }
          bool bad = false;
          while (auto m = reader.next()) {
            std::string_view body {(const char *) m->body.data(), m->body.size()};
            if (!hello) {
              if (m->type != (std::uint8_t) wire::in_t::hello || !wire::same_token(body, token)) {
                BOOST_LOG(warning) << "phosphorus link: a connection without the token, closed"sv;
                bad = true;
                break;
              }
              hello = true;
              take_over(c);
              continue;
            }
            handle(c, m->type, std::move(m->body));
          }
          if (bad || reader.broken()) {
            break;
          }
        }
        std::lock_guard lg {lock};
        if (current == c) {
          // nobody to send to: the video stopped, the app kept for whoever comes next
          stop_video();
          current.reset();
        }
        c->close();
      }

      void take_over(const std::shared_ptr<conn_t> &c) {
        std::lock_guard lg {lock};
        if (current && current != c) {
          stop_video();
          current->close();
        }
        current = c;
        bool vd = false;
#ifdef _WIN32
        vd = proc::vDisplayDriverStatus == VDISPLAY::DRIVER_STATUS::OK;
#endif
        c->send(wire::out_t::ready, json {
                                      {"version", PROJECT_VERSION},
                                      {"virtual_display", vd},
                                      {"hostname", asio::ip::host_name()},
                                      {"running", launched && proc::proc.running() != 0},
                                    });
      }

      void handle(const std::shared_ptr<conn_t> &c, std::uint8_t type, std::vector<std::uint8_t> &&body) {
        auto text = [&]() {
          return std::string {body.begin(), body.end()};
        };
        switch ((wire::in_t) type) {
          case wire::in_t::input:
            {
              std::lock_guard lg {lock};
              if (video_run && video_run->input && body.size() >= 8) {
                input::passthrough(video_run->input, std::move(body), crypto::PERM::_all);
              }
              return;
            }
          case wire::in_t::idr:
            {
              std::lock_guard lg {lock};
              if (video_run) {
                video_run->idr->raise(true);
              }
              return;
            }
          case wire::in_t::ping:
            c->send(wire::message(wire::out_t::pong, std::string_view {(const char *) body.data(), body.size()}));
            return;
          case wire::in_t::stop_video:
            {
              std::lock_guard lg {lock};
              stop_video();
              return;
            }
          case wire::in_t::quit:
            {
              std::lock_guard lg {lock};
              stop_video();
              if (launched) {
                proc::proc.terminate();
                launched = false;
              }
              c->send(wire::out_t::exited, json::object());
              return;
            }
          case wire::in_t::launch:
            return launch(c, json::parse(text(), nullptr, false));
          case wire::in_t::video:
            return video(c, json::parse(text(), nullptr, false));
          default:
            return;
        }
      }

      static int num(const json &j, const char *k, int d, int lo, int hi) {
        auto it = j.find(k);
        if (it == j.end() || !it->is_number()) {
          return d;
        }
        return std::clamp(it->get<int>(), lo, hi);
      }

      // the app started, or found running already
      void launch(const std::shared_ptr<conn_t> &c, const json &j) {
        if (!j.is_object()) {
          c->send(wire::out_t::launched, json {{"ok", false}, {"error", "a launch that isn't json"}});
          return;
        }
        std::lock_guard lg {lock};
        if (launched && proc::proc.running() && !j.value("fresh", false)) {
          c->send(wire::out_t::launched, json {{"ok", true}, {"resumed", true}});
          return;
        }
        auto cmd = wire::launcher_cmd(j.value("cmd", ""s));
        if (!cmd) {
          c->send(wire::out_t::launched, json {{"ok", false}, {"error", "not an app this host can start"}});
          return;
        }
        stop_video();

        proc::ctx_t app {};
        app.id = "1";
        app.uuid = display_uuid;
        app.name = j.value("name", "phosphorus"s);
        app.cmd = *cmd;
        app.auto_detach = true;
        app.wait_all = true;
        app.elevated = false;
        app.virtual_display = j.value("virtual_display", true);
        app.virtual_display_primary = false;
        app.use_app_identity = false;
        app.per_client_app_identity = false;
        app.allow_client_commands = false;
        app.terminate_on_pause = false;
        app.scale_factor = 100;
        app.exit_timeout = 5s;

        auto ls = std::make_shared<rtsp_stream::launch_session_t>();
        ls->id = ++launches;
        ls->device_name = "Phosphorus";
        ls->unique_id = display_uuid;
        ls->perm = crypto::PERM::_all;
        ls->input_only = false;
        ls->host_audio = true;
        ls->width = num(j, "w", 1280, 64, 7680) & ~1;
        ls->height = num(j, "h", 720, 64, 4320) & ~1;
        ls->fps = num(j, "fps", 60, 10, 240) * 1000;
        ls->gcmap = 0;
        ls->surround_info = 196610;
        ls->enable_hdr = false;
        ls->enable_sops = false;
        ls->virtual_display = app.virtual_display;
        ls->scale_factor = 100;

        auto t0 = std::chrono::steady_clock::now();
        auto err = proc::proc.execute(app, ls);
        if (err) {
          launched = false;
          c->send(wire::out_t::launched, json {{"ok", false}, {"code", err}, {"error", err == 503 ? "no display or encoder to capture with" : "the app didn't start"}});
          return;
        }
        launched = true;
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
        BOOST_LOG(info) << "phosphorus link: launched ["sv << app.name << "] in "sv << ms << "ms"sv;
        c->send(wire::out_t::launched, json {{"ok", true}, {"resumed", false}, {"ms", ms}});
      }

      // a fresh video at this size and rate, its first frame a keyframe
      void video(const std::shared_ptr<conn_t> &c, const json &j) {
        if (!j.is_object()) {
          return;
        }
        std::lock_guard lg {lock};
        stop_video();
        if (!launched) {
          c->send(wire::out_t::video_ended, json {{"gen", num(j, "gen", 0, 0, 65535)}, {"why", "no app is running"}});
          return;
        }
        int w = num(j, "w", 1280, 64, 7680) & ~1;
        int h = num(j, "h", 720, 64, 4320) & ~1;
        int fps = num(j, "fps", 60, 10, 240);
#ifdef _WIN32
        // the virtual display follows the viewer's window: the app redraws at its size
        if (proc::proc.virtual_display && !proc::proc.display_name.empty()) {
          VDISPLAY::changeDisplaySettings(platf::from_utf8(proc::proc.display_name).c_str(), w, h, fps * 1000);
        }
#endif
        video::config_t cfg {};
        cfg.width = w;
        cfg.height = h;
        cfg.framerate = fps;
        cfg.encodingFramerate = fps * 1000;
        cfg.bitrate = num(j, "kbps", 20000, 500, 500000);
        cfg.slicesPerFrame = 1;
        cfg.numRefFrames = 0;
        cfg.encoderCscMode = 0;
        cfg.videoFormat = 0;  // H.264: what every browser decodes
        cfg.dynamicRange = 0;
        cfg.chromaSamplingType = j.value("yuv444", false) ? 1 : 0;
        cfg.enableIntraRefresh = 0;
        cfg.input_only = false;

        auto r = std::make_shared<run_t>();
        r->mail = std::make_shared<safe::mail_raw_t>();
        r->shutdown = r->mail->event<bool>(mail::shutdown);
        r->idr = r->mail->event<bool>(mail::idr);
        r->input = input::alloc(r->mail);
        r->gen = (std::uint16_t) num(j, "gen", 0, 0, 65535);
        r->w = (std::uint16_t) w;
        r->h = (std::uint16_t) h;
        auto conn = current;
        auto raw = r.get();
        r->capture = std::thread {[raw, cfg]() {
          platf::adjust_thread_priority(platf::thread_priority_e::high);
          video::capture(raw->mail, cfg, raw);
          raw->ended = true;
        }};
        r->pump = std::thread {[raw, conn]() {
          pump(*raw, conn);
        }};
        video_run = std::move(r);
      }

      // frames from the encoder's queue to the connection as each is made
      static void pump(run_t &r, std::shared_ptr<conn_t> conn) {
        platf::adjust_thread_priority(platf::thread_priority_e::high);
        auto packets = mail::man->queue<video::packet_t>(mail::video_packets);
        std::vector<std::uint8_t> scratch;
        while (!r.stopping) {
          auto p = packets->pop(50ms);
          if (!p) {
            continue;
          }
          if (p->channel_data != &r || !conn) {
            continue;
          }
          auto bits = replaced(*p, scratch);
          auto out = r.shaper.shape((const std::uint8_t *) bits.data(), bits.size(), p->is_idr(), r.gen, r.w, r.h);
          if (!conn->send(out.config) || !conn->send(out.frame)) {
            return;
          }
        }
      }

      // the running video stopped and joined; the app left running. Called with lock held
      void stop_video() {
        if (!video_run) {
          return;
        }
        auto r = std::move(video_run);
        r->stopping = true;
        r->shutdown->raise(true);
        if (r->capture.joinable()) {
          r->capture.join();
        }
        if (r->pump.joinable()) {
          r->pump.join();
        }
        // no key left held down on the host
        input::reset(r->input);
      }

      std::uint16_t port;
      std::string token;
      asio::io_context io;
      std::thread watcher;

      std::mutex lock;
      std::shared_ptr<conn_t> current;
      std::shared_ptr<run_t> video_run;
      bool launched = false;
      std::uint32_t launches = 0;
    };
  }  // namespace

  int run_link(std::uint16_t port, const std::string &token) {
    if (token.size() < 16) {
      BOOST_LOG(fatal) << "phosphorus link: phos_link_token is missing or shorter than 16 characters"sv;
      return -1;
    }
    link_t l {port, token};
    return l.run();
  }
}  // namespace phos
