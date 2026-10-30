set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
find_package(Qt6 6.4 REQUIRED COMPONENTS Core Gui Widgets Network OpenGLWidgets Test)
find_package(LibtorrentRasterbar CONFIG REQUIRED)
if(MINGW)
  # Asio's automatic pthread detection depends on which headers were included
  # first. Mixing its unversioned Win32/pthread types across a DLL corrupts
  # thread ownership. Use one explicit backend in the library and its consumers.
  set(WATCHPAIR_TORRENT_BUILD_RECEIPT "" CACHE FILEPATH "Receipt from build-libtorrent-matched.ps1")
  if(NOT EXISTS "${WATCHPAIR_TORRENT_BUILD_RECEIPT}")
    message(FATAL_ERROR "Build the matched libtorrent runtime with v2/scripts/build-libtorrent-matched.ps1, then configure LibtorrentRasterbar_DIR and WATCHPAIR_TORRENT_BUILD_RECEIPT from its prefix. The stock mixed-backend DLL is not supported.")
  endif()
  file(READ "${WATCHPAIR_TORRENT_BUILD_RECEIPT}" WATCHPAIR_TORRENT_RECEIPT_JSON)
  string(JSON WATCHPAIR_TORRENT_RECEIPT_FORMAT ERROR_VARIABLE WATCHPAIR_TORRENT_RECEIPT_ERROR GET "${WATCHPAIR_TORRENT_RECEIPT_JSON}" format)
  string(JSON WATCHPAIR_TORRENT_BACKEND ERROR_VARIABLE WATCHPAIR_TORRENT_BACKEND_ERROR GET "${WATCHPAIR_TORRENT_RECEIPT_JSON}" asioThreadBackend)
  string(JSON WATCHPAIR_TORRENT_DLL_HASH ERROR_VARIABLE WATCHPAIR_TORRENT_HASH_ERROR GET "${WATCHPAIR_TORRENT_RECEIPT_JSON}" dll sha256)
  if(WATCHPAIR_TORRENT_RECEIPT_ERROR OR WATCHPAIR_TORRENT_BACKEND_ERROR OR WATCHPAIR_TORRENT_HASH_ERROR OR
      NOT WATCHPAIR_TORRENT_RECEIPT_FORMAT EQUAL 1 OR NOT WATCHPAIR_TORRENT_BACKEND STREQUAL "pthread")
    message(FATAL_ERROR "The libtorrent build receipt must describe a format-1 matched pthread runtime.")
  endif()
  get_target_property(WATCHPAIR_TORRENT_DLL LibtorrentRasterbar::torrent-rasterbar IMPORTED_LOCATION_RELEASE)
  if(NOT WATCHPAIR_TORRENT_DLL)
    get_target_property(WATCHPAIR_TORRENT_DLL LibtorrentRasterbar::torrent-rasterbar IMPORTED_LOCATION)
  endif()
  if(NOT EXISTS "${WATCHPAIR_TORRENT_DLL}")
    message(FATAL_ERROR "The selected libtorrent package does not provide its Windows runtime DLL.")
  endif()
  file(SHA256 "${WATCHPAIR_TORRENT_DLL}" WATCHPAIR_TORRENT_ACTUAL_HASH)
  if(NOT WATCHPAIR_TORRENT_ACTUAL_HASH STREQUAL WATCHPAIR_TORRENT_DLL_HASH)
    message(FATAL_ERROR "The selected libtorrent DLL does not match its build receipt. Select the matched package prefix.")
  endif()
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${WATCHPAIR_TORRENT_DLL}" "${WATCHPAIR_TORRENT_BUILD_RECEIPT}")
  file(WRITE "${CMAKE_BINARY_DIR}/torrent-runtime-selection.txt" "${WATCHPAIR_TORRENT_DLL}\n${WATCHPAIR_TORRENT_BUILD_RECEIPT}\n")
  target_compile_definitions(LibtorrentRasterbar::torrent-rasterbar INTERFACE BOOST_ASIO_HAS_PTHREADS=1)
endif()
get_target_property(WATCHPAIR_TORRENT_CONFIGS LibtorrentRasterbar::torrent-rasterbar IMPORTED_CONFIGURATIONS)
if(WIN32 AND CMAKE_BUILD_TYPE STREQUAL "Debug" AND NOT "DEBUG" IN_LIST WATCHPAIR_TORRENT_CONFIGS)
  message(FATAL_ERROR "Use RelWithDebInfo/Release with the packaged release libtorrent DLL, or build matching debug dependencies.")
endif()
if(NOT TARGET watchpair_mpv)
  if(WIN32)
    find_path(MPV_INCLUDE_DIR mpv/client.h REQUIRED)
    find_library(MPV_LIBRARY NAMES mpv libmpv REQUIRED)
    add_library(watchpair_mpv UNKNOWN IMPORTED GLOBAL)
    set_target_properties(watchpair_mpv PROPERTIES IMPORTED_LOCATION "${MPV_LIBRARY}" INTERFACE_INCLUDE_DIRECTORIES "${MPV_INCLUDE_DIR}")
  else()
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(MPV REQUIRED IMPORTED_TARGET GLOBAL mpv)
    add_library(watchpair_mpv ALIAS PkgConfig::MPV)
  endif()
endif()
function(watchpair_native_runtime target)
  if(WIN32)
    if(MINGW)
      # One staging target per output directory avoids concurrent writers and
      # also refreshes runtimes when no application relink is needed. With
      # CMP0112 NEW, TARGET_FILE_DIR does not introduce a dependency on the exe.
      string(MD5 runtime_id "${CMAKE_CURRENT_BINARY_DIR}")
      set(runtime_target "watchpair_runtime_${runtime_id}")
      if(NOT TARGET ${runtime_target})
        add_custom_target(${runtime_target} ALL
          COMMAND ${CMAKE_COMMAND} -E make_directory "$<TARGET_FILE_DIR:${target}>"
          COMMAND ${CMAKE_COMMAND} -E copy_if_different "${WATCHPAIR_TORRENT_DLL}" "$<TARGET_FILE_DIR:${target}>/libtorrent-rasterbar.dll"
          COMMAND ${CMAKE_COMMAND} -E copy_if_different "${WATCHPAIR_TORRENT_BUILD_RECEIPT}" "$<TARGET_FILE_DIR:${target}>/watchpair-libtorrent-build.json"
          DEPENDS "${WATCHPAIR_TORRENT_DLL}" "${WATCHPAIR_TORRENT_BUILD_RECEIPT}"
          VERBATIM)
      endif()
      add_dependencies(${target} ${runtime_target})
    endif()
    find_file(WATCHPAIR_OPENSSL_LEGACY_PROVIDER NAMES legacy.dll PATH_SUFFIXES lib/ossl-modules REQUIRED)
    add_custom_command(TARGET ${target} POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E make_directory "$<TARGET_FILE_DIR:${target}>/ossl-modules"
      COMMAND ${CMAKE_COMMAND} -E copy_if_different "${WATCHPAIR_OPENSSL_LEGACY_PROVIDER}" "$<TARGET_FILE_DIR:${target}>/ossl-modules/legacy.dll")
    find_file(WATCHPAIR_CA_BUNDLE NAMES ca-bundle.crt PATH_SUFFIXES etc/ssl/certs REQUIRED)
    add_custom_command(TARGET ${target} POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E make_directory "$<TARGET_FILE_DIR:${target}>/certs"
      COMMAND ${CMAKE_COMMAND} -E copy_if_different "${WATCHPAIR_CA_BUNDLE}" "$<TARGET_FILE_DIR:${target}>/certs/ca-bundle.crt")
  endif()
endfunction()
