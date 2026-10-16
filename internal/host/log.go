package host

import "os"

// openLog state/phosphorus.log appended to, the previous one kept as .1 once past 20MB
func openLog() *os.File {
	p := at("state", "phosphorus.log")
	if st, err := os.Stat(p); err == nil && st.Size() > 20<<20 {
		os.Remove(p + ".1")
		os.Rename(p, p+".1")
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil
	}
	return f
}
