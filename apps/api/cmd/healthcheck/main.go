// Image HEALTHCHECK. The API process is healthy when GET /api/v1/health
// on port 8080 returns 200. The runner, local worker, migrate, and
// kek-rotate commands do not listen; a live pid 1 is enough for those.
package main

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/imagehealth"
)

func main() {
	raw, err := os.ReadFile("/proc/1/cmdline")
	if err != nil {
		os.Exit(1)
	}
	cmdline := string(bytes.ReplaceAll(raw, []byte{0}, []byte{' '}))
	os.Exit(imagehealth.ExitCode(cmdline, probeAPI))
}

func probeAPI() error {
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get("http://127.0.0.1:8080/api/v1/health")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if _, err := io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16)); err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("health status %d", resp.StatusCode)
	}
	return nil
}
