package anonymize

import "io"

// InputError distinguishes failed source reads from invalid terms or worker
// failures. The wrapped error is retained for classification, never display.
type InputError struct{ Err error }

func (e *InputError) Error() string { return "anonymization_input_failed" }
func (e *InputError) Unwrap() error { return e.Err }

type inputReader struct{ io.Reader }

func (r inputReader) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	if err != nil && err != io.EOF {
		return n, &InputError{Err: err}
	}
	return n, err
}
