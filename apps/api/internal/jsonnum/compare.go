package jsonnum

import (
	"encoding/json"
	"errors"
	"math"
	"math/big"
	"strconv"
)

// ErrNotNumber is returned for a value that is not a JSON number.
var ErrNotNumber = errors.New("jsonnum: not a number")

// ErrTooLarge is returned for a number that cannot be compared exactly.
// Callers report it with a fixed message and never echo the value.
var ErrTooLarge = errors.New("jsonnum: value is too large to compare exactly")

// maxWholeDigits bounds a whole literal read exactly (more than any
// float64 magnitude), so an oversized literal fails closed cheaply.
const maxWholeDigits = 400

// Int64 returns n exactly when it is a whole literal that fits int64.
func Int64(n json.Number) (int64, bool) {
	if !IsWholeLiteral(n) || len(n) > maxWholeDigits {
		return 0, false
	}
	b, ok := new(big.Int).SetString(string(n), 10)
	if !ok || !b.IsInt64() {
		return 0, false
	}
	return b.Int64(), true
}

// Int returns n exactly when it is a whole literal that fits int.
func Int(n json.Number) (int, bool) {
	i, ok := Int64(n)
	if !ok || i < math.MinInt || i > math.MaxInt {
		return 0, false
	}
	return int(i), true
}

// Rat returns a JSON number value as an exact rational: Go integer
// widths, finite floats, and json.Number (a whole literal exactly; a
// fraction or exponent as the float64 it parses to). It returns
// ErrNotNumber for anything else and ErrTooLarge for a literal too long
// or out of float64 range.
func Rat(v any) (*big.Rat, error) {
	switch n := v.(type) {
	case int:
		return new(big.Rat).SetInt64(int64(n)), nil
	case int8:
		return new(big.Rat).SetInt64(int64(n)), nil
	case int16:
		return new(big.Rat).SetInt64(int64(n)), nil
	case int32:
		return new(big.Rat).SetInt64(int64(n)), nil
	case int64:
		return new(big.Rat).SetInt64(n), nil
	case uint:
		return new(big.Rat).SetUint64(uint64(n)), nil
	case uint8:
		return new(big.Rat).SetUint64(uint64(n)), nil
	case uint16:
		return new(big.Rat).SetUint64(uint64(n)), nil
	case uint32:
		return new(big.Rat).SetUint64(uint64(n)), nil
	case uint64:
		return new(big.Rat).SetUint64(n), nil
	case float32:
		return floatRat(float64(n))
	case float64:
		return floatRat(n)
	case json.Number:
		if IsWholeLiteral(n) {
			if len(n) > maxWholeDigits {
				return nil, ErrTooLarge
			}
			b, ok := new(big.Int).SetString(string(n), 10)
			if !ok {
				return nil, ErrNotNumber
			}
			return new(big.Rat).SetInt(b), nil
		}
		f, err := strconv.ParseFloat(string(n), 64)
		if err != nil {
			var ne *strconv.NumError
			if errors.As(err, &ne) && errors.Is(ne.Err, strconv.ErrRange) {
				return nil, ErrTooLarge
			}
			return nil, ErrNotNumber
		}
		return floatRat(f)
	}
	return nil, ErrNotNumber
}

func floatRat(f float64) (*big.Rat, error) {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return nil, ErrNotNumber
	}
	return new(big.Rat).SetFloat64(f), nil
}

// IsNumber reports whether v is a JSON number (see Rat). An oversized
// literal is still a number.
func IsNumber(v any) bool {
	_, err := Rat(v)
	return err == nil || errors.Is(err, ErrTooLarge)
}

// IsInteger reports whether v is a whole JSON number, exactly.
func IsInteger(v any) (bool, error) {
	r, err := Rat(v)
	if err != nil {
		return false, err
	}
	return r.IsInt(), nil
}

// Compare compares two JSON numbers exactly (-1, 0, +1).
func Compare(a, b any) (int, error) {
	ra, err := Rat(a)
	if err != nil {
		return 0, err
	}
	rb, err := Rat(b)
	if err != nil {
		return 0, err
	}
	return ra.Cmp(rb), nil
}

// Float64 returns v as a float64 only when that is exact.
func Float64(v any) (float64, bool) {
	r, err := Rat(v)
	if err != nil {
		return 0, false
	}
	f, exact := r.Float64()
	return f, exact
}
