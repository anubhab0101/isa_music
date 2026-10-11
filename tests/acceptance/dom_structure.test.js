/**
 * Acceptance Criteria Test: DOM Structure Validation for index.html
 *
 * Verifies:
 * 1. Expandable full-screen player structure (#expandable-player or .expandable-player).
 * 2. Sticky minimizable mini-player structure (#mini-player or .mini-player).
 * 3. Audio quality selector toggles (High, Medium, Low, FLAC).
 * 4. Crossfade settings control (#crossfade-slider).
 * 5. Daily quota consumption indicator (#quota-indicator).
 * 6. Real-time search dropdown container (#search-dropdown).
 * 7. Mobile-first viewport configuration.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const INDEX_HTML_PATH = path.resolve(__dirname, '../../index.html');

describe('Acceptance Criteria: Frontend DOM Structure Verification', () => {
  let html = '';

  it('verifies index.html exists in project root', () => {
    assert.strictEqual(fs.existsSync(INDEX_HTML_PATH), true, 'index.html must exist in project root');
    html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    assert.ok(html.length > 0, 'index.html must not be empty');
  });

  it('verifies mobile-first viewport meta tag', () => {
    const hasViewport = /<meta\s+name=["']viewport["']\s+content=["'][^"']*width=device-width/i.test(html);
    assert.strictEqual(hasViewport, true, 'index.html must contain responsive viewport meta tag');
  });

  it('verifies expandable player DOM element exists', () => {
    const hasExpandablePlayer =
      /id=["']expandable-player["']/i.test(html) ||
      /class=["'][^"']*expandable-player[^"']*["']/i.test(html) ||
      /data-player=["']expandable["']/i.test(html);

    assert.strictEqual(
      hasExpandablePlayer,
      true,
      'index.html must contain an expandable player element (#expandable-player or .expandable-player)'
    );
  });

  it('verifies minimizable mini-player DOM element exists', () => {
    const hasMiniPlayer =
      /id=["']mini-player["']/i.test(html) ||
      /class=["'][^"']*mini-player[^"']*["']/i.test(html) ||
      /class=["'][^"']*player-bar[^"']*["']/i.test(html);

    assert.strictEqual(
      hasMiniPlayer,
      true,
      'index.html must contain a mini player element (#mini-player or .player-bar)'
    );
  });

  it('verifies audio quality selector toggles exist with High, Medium, Low, and FLAC options', () => {
    // Check for quality selector container
    const hasQualityContainer =
      /id=["']quality-selector["']/i.test(html) ||
      /class=["'][^"']*quality-selector[^"']*["']/i.test(html) ||
      /data-quality/i.test(html) ||
      /class=["'][^"']*quality-toggles[^"']*["']/i.test(html);

    // Check individual options
    const hasHigh = /data-quality=["']high["']/i.test(html) || />\s*High\s*</i.test(html);
    const hasMedium = /data-quality=["']medium["']/i.test(html) || />\s*Medium\s*</i.test(html);
    const hasLow = /data-quality=["']low["']/i.test(html) || />\s*Low\s*</i.test(html);
    const hasFlac = /data-quality=["']flac["']/i.test(html) || />\s*FLAC\s*</i.test(html);

    assert.strictEqual(
      hasQualityContainer && hasHigh && hasMedium && hasLow && hasFlac,
      true,
      `Quality toggles missing in index.html: container=${hasQualityContainer}, High=${hasHigh}, Med=${hasMedium}, Low=${hasLow}, FLAC=${hasFlac}`
    );
  });

  it('verifies crossfade duration control exists', () => {
    const hasCrossfade =
      /id=["']crossfade-slider["']/i.test(html) ||
      /name=["']crossfade["']/i.test(html) ||
      /class=["'][^"']*crossfade-slider[^"']*["']/i.test(html) ||
      /data-control=["']crossfade["']/i.test(html);

    assert.strictEqual(
      hasCrossfade,
      true,
      'index.html must contain crossfade controls (#crossfade-slider or .crossfade-slider)'
    );
  });

  it('verifies daily YouTube API quota consumption indicator exists', () => {
    const hasQuotaIndicator =
      /id=["']quota-indicator["']/i.test(html) ||
      /class=["'][^"']*quota-indicator[^"']*["']/i.test(html) ||
      /class=["'][^"']*quota-meter[^"']*["']/i.test(html) ||
      /id=["']quota-meter["']/i.test(html);

    assert.strictEqual(
      hasQuotaIndicator,
      true,
      'index.html must contain a daily quota consumption indicator (#quota-indicator or .quota-meter)'
    );
  });

  it('verifies real-time search dropdown DOM container exists', () => {
    const hasSearchDropdown =
      /id=["']search-dropdown["']/i.test(html) ||
      /class=["'][^"']*search-dropdown[^"']*["']/i.test(html) ||
      /class=["'][^"']*search-results[^"']*["']/i.test(html);

    assert.strictEqual(
      hasSearchDropdown,
      true,
      'index.html must contain a search dropdown container (#search-dropdown or .search-dropdown)'
    );
  });
});
