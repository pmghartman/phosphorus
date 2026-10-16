# every image of one arch in one bake, the build stage shared by all three
variable "REGISTRY" { default = "phosphorus" }
variable "ARCH" { default = "amd64" }
variable "VER" { default = "0.0.0" }

group "default" {
  targets = ["phosphorus", "model", "git"]
}

target "_base" {
  context    = "."
  dockerfile = "container/Dockerfile"
  platforms  = ["linux/${ARCH}"]
  cache-from = ["type=gha,scope=${ARCH}"]
}

target "phosphorus" {
  inherits = ["_base"]
  args     = { PHOSPHORUS_VERSION = VER }
  output   = ["type=image,name=${REGISTRY}/phosphorus,push-by-digest=true,name-canonical=true,push=true"]
  cache-to = ["type=gha,mode=max,scope=${ARCH}"]
}

target "model" {
  inherits = ["_base"]
  target   = "model"
  output   = ["type=image,name=${REGISTRY}/phosphorus-model,push-by-digest=true,name-canonical=true,push=true"]
}

target "git" {
  inherits = ["_base"]
  target   = "git"
  output   = ["type=image,name=${REGISTRY}/phosphorus-git,push-by-digest=true,name-canonical=true,push=true"]
}
