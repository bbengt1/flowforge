package httpapi

import "testing"

func TestValidRequestID(t *testing.T) {
	if validRequestID("short") {
		t.Fatal("too short")
	}
	if !validRequestID("abcdefghijklmnop") {
		t.Fatal("16 letters should pass")
	}
	if !validRequestID("01234567-89ab-cdef") {
		t.Fatal("hyphens should pass")
	}
	if validRequestID("abcdefghijklmno_") {
		t.Fatal("underscore should fail")
	}
}
