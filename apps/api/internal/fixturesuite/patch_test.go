package fixturesuite

import (
	"fmt"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// ApplyPatch rewrites workflow YAML. Keys are dotted paths with [n]
// indexes ("spec.nodes[0].with.value.env"); "drop-edge" removes the edges
// whose `from` equals the value.
func ApplyPatch(src string, p Patch) (string, error) {
	if len(p) == 0 {
		return src, nil
	}
	var doc any
	if err := yaml.Unmarshal([]byte(src), &doc); err != nil {
		return "", err
	}
	for path, val := range p {
		var err error
		if path == "drop-edge" {
			err = dropEdge(doc, fmt.Sprint(val))
		} else {
			err = setPath(doc, path, val)
		}
		if err != nil {
			return "", fmt.Errorf("patch %s: %w", path, err)
		}
	}
	out, err := yaml.Marshal(doc)
	return string(out), err
}

type step struct {
	key   string
	index int // -1 when not an index
}

func parsePath(path string) ([]step, error) {
	var out []step
	for _, seg := range strings.Split(path, ".") {
		name, rest, _ := strings.Cut(seg, "[")
		if name != "" {
			out = append(out, step{key: name, index: -1})
		}
		for rest != "" {
			num, after, ok := strings.Cut(rest, "]")
			i, err := strconv.Atoi(num)
			if !ok || err != nil {
				return nil, fmt.Errorf("bad index in %q", seg)
			}
			out = append(out, step{index: i})
			rest = strings.TrimPrefix(after, "[")
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("empty path")
	}
	return out, nil
}

func setPath(doc any, path string, val any) error {
	steps, err := parsePath(path)
	if err != nil {
		return err
	}
	cur := doc
	for i, s := range steps {
		last := i == len(steps)-1
		if s.index >= 0 {
			list, ok := cur.([]any)
			if !ok || s.index >= len(list) {
				return fmt.Errorf("no index %d", s.index)
			}
			if last {
				list[s.index] = val
				return nil
			}
			cur = list[s.index]
			continue
		}
		m, ok := cur.(map[string]any)
		if !ok {
			return fmt.Errorf("%s is not a map", s.key)
		}
		if last {
			m[s.key] = val
			return nil
		}
		next, ok := m[s.key]
		if !ok {
			next = map[string]any{}
			m[s.key] = next
		}
		cur = next
	}
	return nil
}

func dropEdge(doc any, from string) error {
	spec, _ := doc.(map[string]any)["spec"].(map[string]any)
	edges, ok := spec["edges"].([]any)
	if !ok {
		return fmt.Errorf("no spec.edges")
	}
	kept := edges[:0]
	n := 0
	for _, e := range edges {
		if m, ok := e.(map[string]any); ok && m["from"] == from {
			n++
			continue
		}
		kept = append(kept, e)
	}
	if n == 0 {
		return fmt.Errorf("no edge from %s", from)
	}
	spec["edges"] = kept
	return nil
}
