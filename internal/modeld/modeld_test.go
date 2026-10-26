package modeld

import "testing"

// torus's llama-server, 2026-10-26: Vulkan's device lost, then every decode failing
func TestGPULost(t *testing.T) {
	for _, l := range []string{
		"E srv  update_slots: decode() failed: vk::CommandBuffer::end: ErrorDeviceLost",
		"E srv    send_error: task id = 6, error: decode() failed: vk::CommandBuffer::end: ErrorUnknown",
	} {
		if !gpuLostRe.MatchString(l) {
			t.Errorf("not taken as a lost gpu: %q", l)
		}
	}
	for _, l := range []string{
		"E srv  update_slots: decode() failed: Invalid input batch.",
		"W srv  llama_server: security: no API key is set and CORS allows all origins",
		"ggml_vulkan: Found 1 Vulkan devices:",
	} {
		if gpuLostRe.MatchString(l) {
			t.Errorf("taken as a lost gpu: %q", l)
		}
	}
}
