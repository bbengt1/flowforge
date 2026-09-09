package kubernetes

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"gopkg.in/yaml.v3"
)

// Document is one YAML manifest after parse. Raw is the object map used
// for validation and apply. JSON is the normalized encoding.
type Document struct {
	Index      int
	APIVersion string
	Kind       string
	Name       string
	Namespace  string
	Raw        map[string]any
	JSON       []byte
}

// ParseDocuments splits a multi-doc YAML string, skips empty docs, and
// normalizes each remaining document to JSON. It does not apply policy.
func ParseDocuments(src string) ([]Document, *EngineError) {
	if len(src) > MaxManifestBytes {
		return nil, engineError(CodeInvalidManifest, fmt.Sprintf("manifests exceed the %d byte limit.", MaxManifestBytes), http.StatusBadRequest)
	}
	dec := yaml.NewDecoder(bytes.NewReader([]byte(src)))
	dec.KnownFields(false)
	var out []Document
	idx := 0
	for {
		var raw any
		if err := dec.Decode(&raw); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return nil, engineError(CodeInvalidManifest, "Manifest YAML could not be parsed.", http.StatusBadRequest)
		}
		if raw == nil {
			idx++
			continue
		}
		obj, ok := asStringKeyMap(raw)
		if !ok {
			return nil, pathError(CodeInvalidManifest, docPath(idx), "Each manifest document must be a mapping.", http.StatusBadRequest)
		}
		if len(obj) == 0 {
			idx++
			continue
		}
		apiVersion, _ := obj["apiVersion"].(string)
		kind, _ := obj["kind"].(string)
		meta, _ := asStringKeyMap(obj["metadata"])
		name, _ := meta["name"].(string)
		ns, _ := meta["namespace"].(string)
		if strings.TrimSpace(apiVersion) == "" || strings.TrimSpace(kind) == "" || strings.TrimSpace(name) == "" {
			return nil, pathError(CodeInvalidManifest, docPath(idx), "Every document requires apiVersion, kind, and metadata.name.", http.StatusBadRequest)
		}
		canon, err := json.Marshal(obj)
		if err != nil {
			return nil, pathError(CodeInvalidManifest, docPath(idx), "Manifest could not be normalized to JSON.", http.StatusBadRequest)
		}
		out = append(out, Document{
			Index:      idx,
			APIVersion: strings.TrimSpace(apiVersion),
			Kind:       strings.TrimSpace(kind),
			Name:       strings.TrimSpace(name),
			Namespace:  strings.TrimSpace(ns),
			Raw:        obj,
			JSON:       canon,
		})
		idx++
	}
	if len(out) == 0 {
		return nil, engineError(CodeInvalidManifest, "manifests must include at least one document.", http.StatusBadRequest)
	}
	return out, nil
}

// ManifestDigest is the SHA-256 of normalized JSON documents in order.
func ManifestDigest(docs []Document) string {
	h := sha256.New()
	for _, d := range docs {
		h.Write(d.JSON)
		h.Write([]byte{'\n'})
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil))
}

func docPath(i int) string {
	return fmt.Sprintf("manifests[%d]", i)
}

func asStringKeyMap(v any) (map[string]any, bool) {
	switch t := v.(type) {
	case map[string]any:
		return t, true
	case Unstructured:
		return map[string]any(t), true
	case map[any]any:
		out := make(map[string]any, len(t))
		for k, child := range t {
			ks, ok := k.(string)
			if !ok {
				return nil, false
			}
			out[ks] = convertYAML(child)
		}
		return out, true
	default:
		return nil, false
	}
}

func convertYAML(v any) any {
	switch t := v.(type) {
	case map[any]any:
		out := make(map[string]any, len(t))
		for k, child := range t {
			ks, ok := k.(string)
			if !ok {
				continue
			}
			out[ks] = convertYAML(child)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, child := range t {
			out[k] = convertYAML(child)
		}
		return out
	case Unstructured:
		return convertYAML(map[string]any(t))
	case []any:
		out := make([]any, len(t))
		for i, child := range t {
			out[i] = convertYAML(child)
		}
		return out
	default:
		return t
	}
}
