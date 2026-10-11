/**
 * Tier 1: Feature Coverage - Mobile-First DOM Elements
 *
 * Covers:
 * - index.html semantic UI components
 * - Player bar / mini player
 * - Top search bar
 * - Mobile bottom navigation or responsive menu
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const INDEX_HTML_PATH = path.resolve(__dirname, '../../index.html');

describe('Tier 1: Feature Coverage - DOM Elements', () => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

  it('verifies search input element is present', () => {
    const hasSearchInput = /<input[^>]+type=["']text["'][^>]*placeholder=[^>]*search/i.test(html) ||
                           /<input[^>]*placeholder=[^>]*search[^>]*>/i.test(html);
    assert.strictEqual(hasSearchInput, true, 'Search input element must exist in index.html');
  });

  it('verifies player controls container is present', () => {
    const hasPlayerControls = /class=["'][^"']*player-controls[^"']*["']/i.test(html) ||
                              /id=["']player-controls["']/i.test(html);
    assert.strictEqual(hasPlayerControls, true, 'Player controls container must exist');
  });

  it('verifies play/pause button is present in the DOM', () => {
    const hasPlayPause = /id=["']main-play-pause["']/i.test(html) ||
                         /class=["'][^"']*btn-play-pause[^"']*["']/i.test(html);
    assert.strictEqual(hasPlayPause, true, 'Play/pause button must exist');
  });

  it('verifies track title and artist display elements exist', () => {
    const hasTitle = /id=["']np-title["']/i.test(html) || /class=["'][^"']*np-title[^"']*["']/i.test(html);
    const hasArtist = /id=["']np-artist["']/i.test(html) || /class=["'][^"']*np-artist[^"']*["']/i.test(html);
    assert.strictEqual(hasTitle && hasArtist, true, 'Now playing title and artist elements must exist');
  });

  it('verifies progress bar container exists', () => {
    const hasProgress = /class=["'][^"']*progress-bar[^"']*["']/i.test(html) ||
                        /class=["'][^"']*progress-container[^"']*["']/i.test(html);
    assert.strictEqual(hasProgress, true, 'Progress bar elements must exist');
  });
});
