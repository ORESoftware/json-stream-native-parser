cmake_minimum_required(VERSION 3.10)
project(json_native_parser)

# Include cmake-js helper (if available)
include(cmake-js/CMakeLists.txt OPTIONAL)

# Set C++ standard
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Source files
set(SOURCES
  native/json-native-parser.cc
)

# Add N-API defines
add_definitions(-DNAPI_VERSION=9)

# Create the native addon
add_library(json_native_parser SHARED ${SOURCES})

# Set output directory to match node-gyp structure
set_target_properties(json_native_parser PROPERTIES
  LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/Release"
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/Release"
  PREFIX ""
  SUFFIX ".node"
)

