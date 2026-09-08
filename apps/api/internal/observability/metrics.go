package observability

import (
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"
	"time"
)

// DefaultBuckets is a Prometheus-style latency histogram in seconds.
var DefaultBuckets = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10}

type counterKey struct {
	Method string
	Route  string
	Status string
}

type histKey struct {
	Method string
	Route  string
}

type histogram struct {
	buckets []uint64
	sum     float64
	count   uint64
}

// Registry is an in-process Prometheus text exposition of HTTP baseline metrics.
// Labels are method/route/status only — never request IDs, queries, or headers.
type Registry struct {
	mu       sync.Mutex
	requests map[counterKey]uint64
	latency  map[histKey]*histogram
	buckets  []float64
}

// NewRegistry returns an empty metrics registry.
func NewRegistry() *Registry {
	return &Registry{
		requests: make(map[counterKey]uint64),
		latency:  make(map[histKey]*histogram),
		buckets:  append([]float64(nil), DefaultBuckets...),
	}
}

// Observe records one finished HTTP request.
func (r *Registry) Observe(method, route string, status int, d time.Duration) {
	if r == nil {
		return
	}
	if method == "" {
		method = "UNKNOWN"
	}
	if route == "" {
		route = "unmatched"
	}
	key := counterKey{Method: method, Route: route, Status: fmt.Sprintf("%d", status)}
	hkey := histKey{Method: method, Route: route}
	sec := d.Seconds()

	r.mu.Lock()
	defer r.mu.Unlock()
	r.requests[key]++
	h := r.latency[hkey]
	if h == nil {
		h = &histogram{buckets: make([]uint64, len(r.buckets))}
		r.latency[hkey] = h
	}
	for i, bound := range r.buckets {
		if sec <= bound {
			h.buckets[i]++
		}
	}
	h.sum += sec
	h.count++
}

// WritePrometheus writes Prometheus 0.0.4 text format.
func (r *Registry) WritePrometheus(w io.Writer) error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, err := io.WriteString(w, "# HELP flowforge_http_requests_total Total HTTP requests handled by the control plane.\n"); err != nil {
		return err
	}
	if _, err := io.WriteString(w, "# TYPE flowforge_http_requests_total counter\n"); err != nil {
		return err
	}
	keys := make([]counterKey, 0, len(r.requests))
	for k := range r.requests {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		a, b := keys[i], keys[j]
		if a.Method != b.Method {
			return a.Method < b.Method
		}
		if a.Route != b.Route {
			return a.Route < b.Route
		}
		return a.Status < b.Status
	})
	for _, k := range keys {
		line := fmt.Sprintf("flowforge_http_requests_total{method=%q,route=%q,status=%q} %d\n",
			k.Method, k.Route, k.Status, r.requests[k])
		if _, err := io.WriteString(w, line); err != nil {
			return err
		}
	}

	if _, err := io.WriteString(w, "# HELP flowforge_http_request_duration_seconds HTTP request duration in seconds.\n"); err != nil {
		return err
	}
	if _, err := io.WriteString(w, "# TYPE flowforge_http_request_duration_seconds histogram\n"); err != nil {
		return err
	}
	hkeys := make([]histKey, 0, len(r.latency))
	for k := range r.latency {
		hkeys = append(hkeys, k)
	}
	sort.Slice(hkeys, func(i, j int) bool {
		if hkeys[i].Method != hkeys[j].Method {
			return hkeys[i].Method < hkeys[j].Method
		}
		return hkeys[i].Route < hkeys[j].Route
	})
	for _, k := range hkeys {
		h := r.latency[k]
		for i, bound := range r.buckets {
			line := fmt.Sprintf("flowforge_http_request_duration_seconds_bucket{method=%q,route=%q,le=%q} %d\n",
				k.Method, k.Route, formatLE(bound), h.buckets[i])
			if _, err := io.WriteString(w, line); err != nil {
				return err
			}
		}
		inf := fmt.Sprintf("flowforge_http_request_duration_seconds_bucket{method=%q,route=%q,le=\"+Inf\"} %d\n",
			k.Method, k.Route, h.count)
		if _, err := io.WriteString(w, inf); err != nil {
			return err
		}
		sum := fmt.Sprintf("flowforge_http_request_duration_seconds_sum{method=%q,route=%q} %s\n",
			k.Method, k.Route, formatFloat(h.sum))
		if _, err := io.WriteString(w, sum); err != nil {
			return err
		}
		count := fmt.Sprintf("flowforge_http_request_duration_seconds_count{method=%q,route=%q} %d\n",
			k.Method, k.Route, h.count)
		if _, err := io.WriteString(w, count); err != nil {
			return err
		}
	}
	return nil
}

func formatLE(v float64) string {
	s := formatFloat(v)
	return s
}

func formatFloat(v float64) string {
	s := strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.9f", v), "0"), ".")
	if s == "" || s == "-0" {
		return "0"
	}
	return s
}
