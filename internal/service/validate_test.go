package service

import (
	"errors"
	"testing"
)

func TestParseIssueURL(t *testing.T) {
	good := []struct {
		in, repo, canonical string
		n                   int64
	}{
		{"https://github.com/acme/widgets/issues/42", "acme/widgets", "https://github.com/acme/widgets/issues/42", 42},
		{"  https://github.com/Acme/Widgets/issues/7/ ", "acme/widgets", "https://github.com/acme/widgets/issues/7", 7},
		{"https://github.com/a-b/c.d_e/issues/1", "a-b/c.d_e", "https://github.com/a-b/c.d_e/issues/1", 1},
	}
	for _, c := range good {
		repo, n, canon, err := ParseIssueURL(c.in)
		if err != nil || repo != c.repo || n != c.n || canon != c.canonical {
			t.Errorf("%q: got %q %d %q %v", c.in, repo, n, canon, err)
		}
	}
	bad := []string{
		"",
		"not a url",
		"http://github.com/acme/widgets/issues/1",      // not https
		"https://www.github.com/acme/widgets/issues/1", // other host
		"https://gitlab.com/acme/widgets/issues/1",
		"https://github.com.evil.com/acme/widgets/issues/1",
		"https://user@github.com/acme/widgets/issues/1",
		"https://github.com:8443/acme/widgets/issues/1",
		"https://github.com/acme/widgets/pull/1", // pull request
		"https://github.com/acme/widgets/issues",
		"https://github.com/acme/widgets/issues/abc",
		"https://github.com/acme/widgets/issues/0",
		"https://github.com/acme/widgets/issues/-3",
		"https://github.com/acme/widgets/issues/1?x=1",
		"https://github.com/acme/widgets/issues/1#issuecomment-5",
		"https://github.com/acme/issues/1",
		"https://github.com/acme/widgets/extra/issues/1",
		"https://github.com/../widgets/issues/1",
		"https://github.com/acme/../issues/1",
		"https://github.com/acme/wid gets/issues/1",
		"https://github.com/acme/widgets/issues/99999999999999999999",
	}
	for _, in := range bad {
		if _, _, _, err := ParseIssueURL(in); !errors.Is(err, ErrInvalidIssueURL) {
			t.Errorf("%q: expected ErrInvalidIssueURL, got %v", in, err)
		}
	}
}

func TestNormalizeTag(t *testing.T) {
	for in, want := range map[string]string{" Backend ": "backend", "v1.2": "v1.2", "area:ui": "area:ui", "a_b-c": "a_b-c"} {
		if got, err := NormalizeTag(in); err != nil || got != want {
			t.Errorf("%q: got %q %v", in, got, err)
		}
	}
	for _, in := range []string{"", "  ", "-x", ".x", "has space", "a/b", "ünï", string(make([]byte, 51))} {
		if _, err := NormalizeTag(in); !errors.Is(err, ErrInvalidTag) {
			t.Errorf("%q: expected ErrInvalidTag, got %v", in, err)
		}
	}
	long := ""
	for i := 0; i < 50; i++ {
		long += "a"
	}
	if _, err := NormalizeTag(long); err != nil {
		t.Errorf("50 chars should be valid: %v", err)
	}
}
