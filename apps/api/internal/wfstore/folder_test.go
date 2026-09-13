package wfstore

import (
	"strings"
	"testing"
)

func TestNormalizeFolderName(t *testing.T) {
	ok, err := NormalizeFolderName("  Ops  ")
	if err != nil || ok != "Ops" {
		t.Fatalf("trim: %q %v", ok, err)
	}
	if _, err := NormalizeFolderName(""); err != ErrFolderName {
		t.Fatalf("empty: %v", err)
	}
	if _, err := NormalizeFolderName("ops/oncall"); err != ErrFolderName {
		t.Fatalf("slash: %v", err)
	}
	if _, err := NormalizeFolderName("op\ns"); err != ErrFolderName {
		t.Fatalf("control: %v", err)
	}
	if _, err := NormalizeFolderName(strings.Repeat("a", MaxFolderNameGraphemes+1)); err != ErrFolderName {
		t.Fatalf("too long: %v", err)
	}
	if _, err := NormalizeFolderName(strings.Repeat("a", MaxFolderNameGraphemes)); err != nil {
		t.Fatalf("max length: %v", err)
	}
	combined := "e\u0301" + strings.Repeat("b", 63)
	if _, err := NormalizeFolderName(combined); err != nil {
		t.Fatalf("combining mark should count as one grapheme: %v", err)
	}
}
