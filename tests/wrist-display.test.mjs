import test from 'node:test';
import assert from 'node:assert/strict';
import { formatWristDisplay } from '../src/core/wristDisplay.js';

function makeState(overrides = {}) {
  return {
    status: 'ACTIVE',
    winner: null,
    sets: [1, 0],
    games: [5, 4],
    points: [2, 1],
    pointsLabel: ['30', '15'],
    inTieBreak: false,
    server: 0,
    changeEndsAlert: false,
    counts: { myUePoints: 3, totalPoints: 20 },
    myUePctOfPointsLost: 0.25,
    revision: 42,
    ...overrides,
  };
}

test('love-all server confirmation, active AD/TB scores, deuce #rev distinction, and default SWP omission', () => {
  const loveAllUs = formatWristDisplay(
    makeState({
      sets: [0, 0],
      games: [0, 0],
      points: [0, 0],
      pointsLabel: ['0', '0'],
      server: 0,
      counts: { myUePoints: 0, totalPoints: 0 },
      revision: 2,
    })
  );
  assert.equal(loveAllUs.title, 'US SERVES #2');
  assert.equal(loveAllUs.artist, '0-0 0-0 S0-0');

  const loveAllThem = formatWristDisplay(
    makeState({
      sets: [0, 0],
      games: [0, 0],
      points: [0, 0],
      pointsLabel: ['0', '0'],
      server: 1,
      counts: { myUePoints: 0, totalPoints: 0 },
      revision: 2,
    })
  );
  assert.equal(loveAllThem.title, 'THEM SERVES #2');
  assert.equal(loveAllThem.artist, '0-0 0-0 S0-0');

  const cases = [
    {
      name: '30-15 Us serving',
      state: makeState(),
      title: '*30-15 5-4 #42',
      artist: 'S1-0 UE:3',
    },
    {
      name: 'AD active default omits SWP clutter',
      state: makeState({
        server: 0,
        points: [4, 3],
        pointsLabel: ['AD', '40'],
        games: [6, 5],
        sets: [1, 1],
        counts: { myUePoints: 12, totalPoints: 60 },
        changeEndsAlert: true,
        revision: 99,
      }),
      title: '*AD-40 6-5 #99',
      artist: 'S1-1 UE:12',
    },
    {
      name: 'marathon 14-13 TB #1000 default omits SWP',
      state: makeState({
        server: 0,
        inTieBreak: true,
        points: [14, 13],
        pointsLabel: ['14', '13'],
        games: [6, 6],
        sets: [1, 1],
        counts: { myUePoints: 100, totalPoints: 120 },
        changeEndsAlert: true,
        revision: 1000,
      }),
      title: '*14-13 TB #1000',
      artist: 'S1-1 UE:100',
    },
  ];

  for (const c of cases) {
    const out = formatWristDisplay(c.state);
    assert.equal(out.title, c.title, c.name);
    assert.equal(out.artist, c.artist, c.name);
    assert.ok(out.title.length <= 20);
    assert.ok(out.artist.length <= 20);
  }

  // Explicit opt-in showSwap:true still renders SWP when requested
  const withSwap = formatWristDisplay(
    makeState({ server: 1, pointsLabel: ['AD', '40'], games: [6, 5], sets: [1, 1], counts: { myUePoints: 12, totalPoints: 50 }, changeEndsAlert: true, revision: 99 }),
    { showSwap: true }
  );
  assert.equal(withSwap.artist, 'S1-1 UE:12 SWP');

  const d1 = formatWristDisplay(makeState({ pointsLabel: ['40', '40'], revision: 14 }));
  const d2 = formatWristDisplay(makeState({ pointsLabel: ['40', '40'], revision: 16 }));
  assert.notEqual(d1.title, d2.title);
});

test('watch server picker (ACTIVE && server === null) keeps both arrow labels together and preserves #rev across widths', () => {
  const pending = makeState({
    sets: [0, 0],
    games: [0, 0],
    points: [0, 0],
    pointsLabel: ['0', '0'],
    server: null,
    needsInitialServer: true,
    counts: { myUePoints: 0, totalPoints: 0 },
    revision: 1,
  });

  const std = formatWristDisplay(pending);
  assert.equal(std.title, 'WHO SERVES? #1');
  assert.equal(std.artist, '< US   THEM >');

  // Narrow width with long revision still keeps BOTH US and THEM + #1000
  const narrowLongRev = formatWristDisplay({ ...pending, revision: 1000 }, { maxTitleLen: 11, maxArtistLen: 11 });
  assert.equal(narrowLongRev.title, 'SERVE? #1000'.length <= 11 ? 'SERVE? #1000' : '<US THEM>');
  assert.ok(narrowLongRev.title.includes('<US THEM>') || narrowLongRev.artist.includes('THEM'));
  assert.ok(narrowLongRev.title.includes('#1000') || narrowLongRev.artist.includes('#1000'));
  assert.ok(narrowLongRev.title.length <= 11);
  assert.ok(narrowLongRev.artist.length <= 11);

  // Tight artist=8 / title=15 moves <US THEM> + #1000 onto title so THEM is never dropped!
  const tightArtist = formatWristDisplay({ ...pending, revision: 1000 }, { maxTitleLen: 15, maxArtistLen: 8 });
  assert.equal(tightArtist.title, '<US THEM> #1000');
  assert.equal(tightArtist.artist, 'SERVE?');

  // Regression: 8/14 fits SERVE? on title and #1 <US THEM> on artist instead of throwing
  const narrowPicker = formatWristDisplay(pending, { maxTitleLen: 8, maxArtistLen: 14 });
  assert.equal(narrowPicker.title, 'SERVE?');
  assert.equal(narrowPicker.artist, '#1 <US THEM>');

  // Width too narrow to hold both arrows (<US THEM>) -> throws explicitly rather than dropping THEM
  assert.throws(
    () => formatWristDisplay(pending, { maxTitleLen: 8, maxArtistLen: 8 }),
    /without dropping required score or revision token/
  );
});

test('Regression: love-all confirmation succeeds symmetrically for US and THEM at narrow 6/14 budget, and manual AD finish preserves AD-40 at 8/20', () => {
  const baseLoveAll = {
    sets: [0, 0],
    games: [0, 0],
    points: [0, 0],
    pointsLabel: ['0', '0'],
    counts: { myUePoints: 0, totalPoints: 0 },
    revision: 2,
  };

  const usNarrow = formatWristDisplay(makeState({ ...baseLoveAll, server: 0 }), { maxTitleLen: 6, maxArtistLen: 14 });
  const themNarrow = formatWristDisplay(makeState({ ...baseLoveAll, server: 1 }), { maxTitleLen: 6, maxArtistLen: 14 });
  assert.ok(usNarrow.title.length <= 6 && usNarrow.artist.length <= 14);
  assert.ok(themNarrow.title.length <= 6 && themNarrow.artist.length <= 14);
  assert.equal(themNarrow.title, '0-0 #2');
  assert.equal(themNarrow.artist, 'THEM SERVES');
  assert.ok(usNarrow.title.includes('US') || usNarrow.artist.includes('US'));
  assert.ok(usNarrow.title.includes('#2') || usNarrow.artist.includes('#2'));

  // Manual finish at AD-40 with 8/20 budget preserves AD-40 on artist instead of erasing it
  const manualAdNarrow = formatWristDisplay(
    makeState({
      status: 'FINISHED_MANUAL',
      sets: [0, 0],
      games: [0, 0],
      points: [4, 3],
      pointsLabel: ['AD', '40'],
      counts: { myUePoints: 0, totalPoints: 7 },
      revision: 9,
    }),
    { maxTitleLen: 8, maxArtistLen: 20 }
  );
  assert.equal(manualAdNarrow.title, 'END 0-0');
  assert.equal(manualAdNarrow.artist, '#9 AD-40 S0-0 UE:0');
});

test('manual finish (including AD and null server), WON percentages, and 12-char AD budgets', () => {
  const manual = formatWristDisplay(makeState({ status: 'FINISHED_MANUAL', revision: 81 }));
  assert.equal(manual.title, 'END 30-15 5-4 #81');
  assert.equal(manual.artist, 'S1-0 UE:3');

  const manualAd = formatWristDisplay(
    makeState({ status: 'FINISHED_MANUAL', points: [4, 3], pointsLabel: ['AD', '40'], games: [6, 5], revision: 99 })
  );
  assert.equal(manualAd.title, 'END AD-40 6-5 #99');
  assert.equal(manualAd.title.length, 17);

  // Narrow 12-char budgets move complete #99 to artist
  const manualAd12 = formatWristDisplay(
    makeState({ status: 'FINISHED_MANUAL', points: [4, 3], pointsLabel: ['AD', '40'], games: [6, 5], revision: 99 }),
    { maxTitleLen: 12, maxArtistLen: 12 }
  );
  assert.ok(manualAd12.title.length <= 12);
  assert.ok(manualAd12.artist.includes('#99'));

  // Manually finished with null opener (0 events) renders END 0-0, NOT WHO SERVES?
  const manualNullOpener = formatWristDisplay(
    makeState({
      status: 'FINISHED_MANUAL',
      server: null,
      needsInitialServer: true,
      sets: [0, 0],
      games: [0, 0],
      points: [0, 0],
      pointsLabel: ['0', '0'],
      counts: { myUePoints: 0, totalPoints: 0 },
      revision: 2,
    })
  );
  assert.equal(manualNullOpener.title, 'END 0-0 #2');

  const win = formatWristDisplay(
    makeState({ status: 'WON', winner: 0, sets: [2, 0], counts: { myUePoints: 4, totalPoints: 50 }, myUePctOfPointsLost: 0.2, revision: 64 })
  );
  assert.equal(win.title, 'WIN 2-0 #64');
  assert.equal(win.artist, 'UE:4 20%');

  const tinyPct = formatWristDisplay(
    makeState({ status: 'WON', winner: 0, sets: [2, 0], counts: { myUePoints: 1, totalPoints: 50 }, myUePctOfPointsLost: 1 / 999, revision: 70 })
  );
  assert.equal(tinyPct.artist, 'UE:1 <1%');

  const zeroUeWithLosses = formatWristDisplay(
    makeState({ status: 'WON', winner: 0, sets: [2, 0], counts: { myUePoints: 0, totalPoints: 50 }, myUePctOfPointsLost: 0, revision: 71 })
  );
  assert.equal(zeroUeWithLosses.artist, 'UE:0 0%');

  const lossNoLosses = formatWristDisplay(
    makeState({ status: 'WON', winner: 1, sets: [0, 2], counts: { myUePoints: 0, totalPoints: 50 }, myUePctOfPointsLost: null, revision: 65 })
  );
  assert.equal(lossNoLosses.title, 'LOSS 0-2 #65');
  assert.equal(lossNoLosses.artist, 'UE:0 —');
});

test('ordinary game overflow never mislabels as tie-break and tight artist never silently drops #rev', () => {
  const narrowOrd = formatWristDisplay(makeState({ revision: 42 }), { maxTitleLen: 9, maxArtistLen: 16 });
  assert.equal(narrowOrd.title, '*30-15');
  assert.equal(narrowOrd.artist, '#42 5-4 S1-0');

  const tight40 = formatWristDisplay(makeState({ revision: 40 }), { maxTitleLen: 10, maxArtistLen: 2 });
  const tight42 = formatWristDisplay(makeState({ revision: 42 }), { maxTitleLen: 10, maxArtistLen: 2 });
  assert.equal(tight40.title, '*30-15 #40');
  assert.equal(tight42.title, '*30-15 #42');
  assert.notEqual(tight40.title, tight42.title);

  assert.throws(
    () => formatWristDisplay(makeState({ revision: 42 }), { maxTitleLen: 8, maxArtistLen: 2 }),
    /without dropping required score or revision token/
  );
});

test('tie-break width boundaries preserve exact scores on manual finish and serve marker on compact active TB', () => {
  const manualTb = makeState({
    status: 'FINISHED_MANUAL',
    inTieBreak: true,
    points: [100, 99],
    pointsLabel: ['100', '99'],
    games: [6, 6],
    revision: 81,
  });

  assert.equal(formatWristDisplay(manualTb, { maxTitleLen: 13, maxArtistLen: 20 }).title, 'END 100-99 TB');
  assert.equal(formatWristDisplay(manualTb, { maxTitleLen: 12, maxArtistLen: 20 }).title, 'END 100-99');
  assert.equal(formatWristDisplay(manualTb, { maxTitleLen: 10, maxArtistLen: 20 }).artist, '#81 TB S1-0 UE:3');

  const activeTbUs = formatWristDisplay(
    makeState({ inTieBreak: true, server: 0, points: [100, 99], pointsLabel: ['100', '99'], revision: 999 }),
    { maxTitleLen: 9, maxArtistLen: 20 }
  );
  assert.equal(activeTbUs.title, '*TB US +1');
  assert.equal(activeTbUs.artist, '#999 S1-0 UE:3');

  const activeTbThem = formatWristDisplay(
    makeState({ inTieBreak: true, server: 1, points: [999, 1000], pointsLabel: ['999', '1000'], revision: 999 }),
    { maxTitleLen: 10, maxArtistLen: 20 }
  );
  assert.equal(activeTbThem.title, 'TB THM +1*');
  assert.equal(activeTbThem.artist, '#999 S1-0 UE:3');
});
