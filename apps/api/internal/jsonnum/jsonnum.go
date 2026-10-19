// Package jsonnum decodes JSON without silently rounding whole numbers.
//
// encoding/json decodes every number into float64, so a whole number
// outside ±2^53 loses digits on the way in (9007199254740993 becomes
// 9007199254740992). Decode and Object keep the existing shape for every
// other number (float64, as encoding/json gives) and keep a whole number
// outside ±2^53 as an exact json.Number, which marshals back unchanged.
package jsonnum

import (
	"bytes"
	"encoding/json"
	"errors"
	"reflect"
	"strconv"
	"strings"
)

// MaxExact is 2^53: every integer with an absolute value up to it is
// exactly representable as a float64 (a JSON number in most clients).
const MaxExact = 1 << 53

// IsWholeLiteral reports whether n is written as an integer (no fraction
// or exponent).
func IsWholeLiteral(n json.Number) bool {
	return !strings.ContainsAny(string(n), ".eE")
}

// InExactRange reports whether i is within ±2^53.
func InExactRange(i int64) bool {
	return i >= -MaxExact && i <= MaxExact
}

// Decode unmarshals raw into an any using UseNumber and Normalize. It
// refuses trailing data like json.Unmarshal.
func Decode(raw []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err == nil {
		return nil, errors.New("jsonnum: trailing data")
	}
	return Normalize(v), nil
}

// Clone is a JSON round trip of v through Decode.
func Clone(v any) (any, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return Decode(raw)
}

// Normalize rewrites json.Number values decoded with UseNumber: a whole
// number outside ±2^53 stays an exact json.Number; every other number
// becomes the float64 encoding/json would have produced. Maps and slices
// are rewritten in place.
func Normalize(v any) any {
	switch x := v.(type) {
	case map[string]any:
		for k, e := range x {
			x[k] = Normalize(e)
		}
		return x
	case []any:
		for i, e := range x {
			x[i] = Normalize(e)
		}
		return x
	case json.Number:
		if IsWholeLiteral(x) {
			if i, err := strconv.ParseInt(string(x), 10, 64); err == nil && InExactRange(i) {
				return float64(i)
			}
			return x
		}
		if f, err := strconv.ParseFloat(string(x), 64); err == nil {
			return f
		}
		return x
	}
	return v
}

// Object is a JSON object field that decodes with Decode. It is a plain
// map[string]any otherwise, so it assigns to and from one directly.
type Object map[string]any

// UnmarshalJSON implements json.Unmarshaler.
func (o *Object) UnmarshalJSON(raw []byte) error {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		*o = nil
		return nil
	}
	v, err := Decode(raw)
	if err != nil {
		return err
	}
	m, ok := v.(map[string]any)
	if !ok {
		return &json.UnmarshalTypeError{Value: "non-object", Type: reflect.TypeOf(map[string]any{})}
	}
	*o = m
	return nil
}
