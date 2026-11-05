/**
 * @file src/phos_link.h
 * @brief afterglow's local link: phosphorus drives Apollo's capture, encoders, input
 * and virtual display over one loopback TCP connection, in place of GameStream.
 */
#pragma once

#include <cstdint>
#include <string>

namespace phos {
  // serve the link on 127.0.0.1:port until shutdown is raised; token is what the
  // client must say first. Returns at once with an error logged when it can't listen
  int run_link(std::uint16_t port, const std::string &token);
}  // namespace phos
