cmake_minimum_required(VERSION 3.20)
# afterglow: phosphorus's GameStream-free streaming host for Windows, forked from
# Apollo (github.com/ClassicOldSong/Apollo, itself a fork of LizardByte's Sunshine).
# Apollo's capture, encoders, input and virtual display, driven by phosphorus over a
# local link (src/phos_link.cpp) instead of GameStream's HTTPS, RTSP, ENet and RTP.
# Windows only: Linux hosts stream through phosphorus's own Xvfb and ffmpeg path

if(NOT WIN32)
    message(FATAL_ERROR "afterglow builds for Windows only (MSYS2 UCRT64)")
endif()

project(Afterglow VERSION 0.0.0
        DESCRIPTION "Phosphorus's streaming host, forked from Apollo"
        HOMEPAGE_URL "https://github.com/pmghartman/phosphorus")

set(PROJECT_LICENSE "GPL-3.0-only")
set(PROJECT_FQDN "dev.phosphorus.afterglow")
set(PROJECT_BRIEF_DESCRIPTION "Phosphorus streaming host")

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE "Release" CACHE STRING "Choose the type of build." FORCE)
endif()

set(CMAKE_MODULE_PATH "${CMAKE_SOURCE_DIR}/cmake")
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

include(${CMAKE_MODULE_PATH}/prep/build_version.cmake)
include(${CMAKE_MODULE_PATH}/prep/options.cmake)
include(${CMAKE_MODULE_PATH}/prep/init.cmake)
include(${CMAKE_MODULE_PATH}/prep/constants.cmake)
include(${CMAKE_MODULE_PATH}/macros/common.cmake)
include(${CMAKE_MODULE_PATH}/dependencies/common.cmake)
include(${CMAKE_MODULE_PATH}/compile_definitions/common.cmake)
include(${CMAKE_MODULE_PATH}/targets/common.cmake)
