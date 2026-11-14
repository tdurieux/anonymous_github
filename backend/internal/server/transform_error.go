package server

import (
	"errors"
	"io"

	"github.com/tdurieux/anonymous_github/backend/internal/anonymize"
)

func transformFailure(err error) error {
	var input *anonymize.InputError
	if errors.As(err, &input) {
		if errors.Is(err, io.ErrUnexpectedEOF) {
			return fail("storage_write_size_mismatch", 502)
		}
		return fail("file_not_available", 502)
	}
	return fail("anonymization_failed", 422)
}
