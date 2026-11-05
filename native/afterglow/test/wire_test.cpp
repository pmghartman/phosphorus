// the link's framing and frame shaping, built with any C++20 compiler on any OS:
//   c++ -std=c++20 -Wall -Wextra -Werror -I../src wire_test.cpp -o wire_test && ./wire_test
#include "phos_wire.h"

#include <cstdio>
#include <cstdlib>

using namespace phos::wire;

static int failed = 0;
#define CHECK(c) \
  do { \
    if (!(c)) { \
      std::fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #c); \
      ++failed; \
    } \
  } while (0)

static std::vector<std::uint8_t> bytes(std::initializer_list<int> l) {
  std::vector<std::uint8_t> v;
  for (int x : l) v.push_back((std::uint8_t) x);
  return v;
}

int main() {
  // messages back out of a stream however it was cut
  {
    auto a = message(out_t::ready, "{\"v\":1}");
    auto b = message((std::uint8_t) in_t::idr, "");
    std::vector<std::uint8_t> s(a);
    s.insert(s.end(), b.begin(), b.end());
    reader_t r;
    for (auto c : s) {
      CHECK(r.feed(&c, 1));
    }
    auto m1 = r.next();
    CHECK(m1 && m1->type == (std::uint8_t) out_t::ready && std::string(m1->body.begin(), m1->body.end()) == "{\"v\":1}");
    auto m2 = r.next();
    CHECK(m2 && m2->type == (std::uint8_t) in_t::idr && m2->body.empty());
    CHECK(!r.next());
  }
  // a length past the limit breaks the stream
  {
    reader_t r;
    auto bad = bytes({0xff, 0xff, 0xff, 0xff, 1});
    r.feed(bad.data(), bad.size());
    CHECK(!r.next());
    CHECK(r.broken());
  }
  // nal units: 3- and 4-byte start codes, trailing padding
  {
    auto s = bytes({0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 9, 9, 0, 0});
    auto l = nals_of(s.data(), s.size());
    CHECK(l.size() == 3);
    CHECK(l[0].type == 7 && l[0].start == 4 && l[0].end == 7);
    CHECK(l[1].type == 8 && l[1].start == 10 && l[1].end == 12);
    CHECK(l[2].type == 5 && l[2].start == 16 && l[2].end == 19);
  }
  // an IDR: parameter sets once as config, the AUD dropped, the slice in AVCC behind the room
  {
    auto s = bytes({0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1f, 0xac, 0, 0, 0, 1, 0x68, 0xee, 0x3c, 0x80,
                    0, 0, 1, 0x65, 0x88, 0x84});
    shaper_t sh;
    auto r = sh.shape(s.data(), s.size(), true, 7, 1280, 720);
    CHECK(!r.config.empty());
    CHECK(get_u32(r.config.data()) == r.config.size() - 4);
    CHECK(r.config[4] == (std::uint8_t) out_t::config);
    CHECK(r.config[8] == (1280 & 0xff) && r.config[9] == (1280 >> 8) && r.config[10] == (720 & 0xff));
    // avcC: version, profile, compat, level from the SPS
    CHECK(r.config[12] == 1 && r.config[13] == 0x64 && r.config[14] == 0x00 && r.config[15] == 0x1f);
    CHECK(r.frame.size() == 4 + head_len + 4 + 3);
    CHECK(get_u32(r.frame.data()) == head_len + 7);
    CHECK(r.frame[4] == (std::uint8_t) out_t::frame && r.frame[5] == 1 && r.frame[6] == 7 && r.frame[7] == 0);
    CHECK(r.config[6] == 7 && r.config[7] == 0);
    CHECK(r.frame[12] == 0 && r.frame[13] == 0 && r.frame[14] == 0 && r.frame[15] == 3);
    CHECK(r.frame[16] == 0x65 && r.frame[18] == 0x84);
    // the same parameter sets again: no config
    auto r2 = sh.shape(s.data(), s.size(), true, 7, 1280, 720);
    CHECK(r2.config.empty());
    // a reset sends them again
    sh.reset();
    CHECK(!sh.shape(s.data(), s.size(), true, 7, 1280, 720).config.empty());
    // a P-frame: two slices, no key
    auto p = bytes({0, 0, 1, 0x41, 1, 0, 0, 1, 0x41, 2, 3});
    auto rp = sh.shape(p.data(), p.size(), false, 7, 1280, 720);
    CHECK(rp.config.empty());
    CHECK(rp.frame[5] == 0);
    CHECK(rp.frame.size() == 4 + head_len + (4 + 2) + (4 + 3));
  }
  // tokens, launch lines
  {
    CHECK(same_token("abc", "abc"));
    CHECK(!same_token("abc", "abd"));
    CHECK(!same_token("", ""));
    CHECK(!same_token("abc", "abcd"));
    CHECK(launcher_cmd("C:\\x\\App.lnk").value() == "cmd.exe /d /c start \"\" /wait \"C:\\x\\App.lnk\"");
    CHECK(!launcher_cmd("a\" & calc"));
    CHECK(!launcher_cmd("a\nb"));
    CHECK(!launcher_cmd(""));
  }
  if (failed) {
    std::fprintf(stderr, "%d failed\n", failed);
    return 1;
  }
  std::puts("wire: ok");
  return 0;
}
