# common macros
# this file will also load platform specific macros

# platform specific macros
include(${CMAKE_MODULE_PATH}/macros/windows.cmake)

# override find_package function
macro(find_package)  # cmake-lint: disable=C0103
    string(TOLOWER "${ARGV0}" ARGV0_LOWER)
    if(
        (("${ARGV0_LOWER}" STREQUAL "boost") AND DEFINED FETCH_CONTENT_BOOST_USED) OR
        (("${ARGV0_LOWER}" STREQUAL "libevdev") AND DEFINED EXTERNAL_PROJECT_LIBEVDEV_USED)
    )
        # Do nothing, as the package has already been fetched
    else()
        # Call the original find_package function
        _find_package(${ARGV})
    endif()
endmacro()
