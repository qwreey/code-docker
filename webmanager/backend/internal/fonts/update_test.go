package fonts

import (
	"fmt"
	"sync"
	"testing"
)

// Concurrent read-modify-writes (two uploads, or an upload during the
// boot-time seed) used to drop all but one of the new entries.
func TestUpdateKeepsConcurrentChanges(t *testing.T) {
	dir := t.TempDir()
	var wg sync.WaitGroup
	for i := range 40 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := Update(dir, func(m *Manifest) error {
				m.Fonts = append(m.Fonts, Font{ID: fmt.Sprint(i)})
				return nil
			}); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	m, err := Load(dir)
	if err != nil || len(m.Fonts) != 40 {
		t.Fatalf("manifest has %d fonts (%v), want 40", len(m.Fonts), err)
	}
}
