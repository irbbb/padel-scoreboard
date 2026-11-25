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
    counts: { myUePoints: 3 },
    myUePctOfPointsLost: 0.25,
    revision: 42,
    ...overrides,
  };
}

test('standard active scores, deuce #rev distinction, AD fixture, and 14-13 TB #1000 fit <= 20 chars', () => {
  const cases = [
    {
      name: '0-0 start',
      state: makeState({ sets: [0, 0], games: [0, 0], points: [0, 0], pointsLabel: ['0', '0'], counts: { myUePoints: 0 }, revision: 1 }),
      title: '*0-0 0-0 #1',
      artist: 'S0-0 UE:0',
    },
    {
      name: '30-15 Us serving',
      state: makeState(),
      title: '*30-15 5-4 #42',
      artist: 'S1-0 UE:3',
    },
    {
      name: 'AD display fixture (Them serving + SWAP)',
      state: makeState({ server: 1, pointsLabel: ['AD', '40'], games: [6, 5], sets: [1, 1], counts: { myUePoints: 12 }, changeEndsAlert: true, revision: 99 }),
      title: 'AD-40* 6-5 #99',
      artist: 'S1-1 UE:12 SWP',
    },
    {
      name: 'marathon 14-13 TB #1000 + 3-digit UE',
      state: makeState({ server: 0, inTieBreak: true, points: [14, 13], pointsLabel: ['14', '13'], games: [6, 6], sets: [1, 1], counts: { myUePoints: 100 }, changeEndsAlert: true, revision: 1000 }),
      title: '*14-13 TB #1000',
      artist: 'S1-1 UE:100 SWP',
    },
  ];

  for (const c of cases) {
    const out = formatWristDisplay(c.state);
    assert.equal(out.title, c.title, c.name);
    assert.equal(out.artist, c.artist, c.name);
    assert.ok(out.title.length <= 20);
    assert.ok(out.artist.length <= 20);
  }

  const d1 = formatWristDisplay(makeState({ pointsLabel: ['40', '40'], revision: 14 }));
  const d2 = formatWristDisplay(makeState({ pointsLabel: ['40', '40'], revision: 16 }));
  assert.notEqual(d1.title, d2.title);
});

test('manual finish, WON percentages (including <1%, 0%, and —), and our-team-first WIN/LOSS', () => {
  const manual = formatWristDisplay(makeState({ status: 'FINISHED_MANUAL', revision: 81 }));
  assert.equal(manual.title, 'END 30-15 5-4 #81');
  assert.equal(manual.artist, 'S1-0 UE:3');

  const win = formatWristDisplay(
    makeState({ status: 'WON', winner: 0, sets: [2, 0], counts: { myUePoints: 4 }, myUePctOfPointsLost: 0.2, revision: 64 })
  );
  assert.equal(win.title, 'WIN 2-0 #64');
  assert.equal(win.artist, 'UE:4 20%');

  const tinyPct = formatWristDisplay(
    makeState({ status: 'WON', winner: 0, sets: [2, 0], counts: { myUePoints: 1 }, myUePctOfPointsLost: 1 / 999, revision: 70 })
  );
  assert.equal(tinyPct.artist, 'UE:1 <1%');

  const zeroUeWithLosses = formatWristDisplay(
    makeState({ status: 'WON', winner: 0, sets: [2, 0], counts: { myUePoints: 0 }, myUePctOfPointsLost: 0, revision: 71 })
  );
  assert.equal(zeroUeWithLosses.artist, 'UE:0 0%');

  const lossNoLosses = formatWristDisplay(
    makeState({ status: 'WON', winner: 1, sets: [0, 2], counts: { myUePoints: 0 }, myUePctOfPointsLost: null, revision: 65 })
  );
  assert.equal(lossNoLosses.title, 'LOSS 0-2 #65');
  assert.equal(lossNoLosses.artist, 'UE:0 —');
});

test('ordinary game overflow never mislabels as tie-break and tight artist never silently drops #rev', () => {
  // At maxTitleLen: 9, ordinary *30-15 5-4 keeps *30-15 (NOT TB US +1!) and moves #42 + 5-4 to artist
  const narrowOrd = formatWristDisplay(makeState({ revision: 42 }), { maxTitleLen: 9, maxArtistLen: 16 });
  assert.equal(narrowOrd.title, '*30-15');
  assert.equal(narrowOrd.artist, '#42 5-4 S1-0');

  // At 10/2, #rev is reserved on title (*30-15 #42) so rev #40 and #42 remain visibly distinct!
  const tight40 = formatWristDisplay(makeState({ revision: 40 }), { maxTitleLen: 10, maxArtistLen: 2 });
  const tight42 = formatWristDisplay(makeState({ revision: 42 }), { maxTitleLen: 10, maxArtistLen: 2 });
  assert.equal(tight40.title, '*30-15 #40');
  assert.equal(tight42.title, '*30-15 #42');
  assert.notEqual(tight40.title, tight42.title);

  // If neither line can hold the minimum score + #rev (title=8, artist=2), throw explicitly!
  assert.throws(
    () => formatWristDisplay(makeState({ revision: 42 }), { maxTitleLen: 8, maxArtistLen: 2 }),
    /without dropping required score or revision token/
  );
});

test('tie-break width boundaries preserve exact scores on manual finish and serve marker on compact active TB', () => {
  // Manually finished marathon TB 100-99 across widths 13, 12, 11, 10
  const manualTb = makeState({
    status: 'FINISHED_MANUAL',
    inTieBreak: true,
    points: [100, 99],
    pointsLabel: ['100', '99'],
    games: [6, 6],
    revision: 81,
  });

  const w13 = formatWristDisplay(manualTb, { maxTitleLen: 13, maxArtistLen: 20 });
  assert.equal(w13.title, 'END 100-99 TB');
  assert.equal(w13.artist, '#81 S1-0 UE:3');

  const w12 = formatWristDisplay(manualTb, { maxTitleLen: 12, maxArtistLen: 20 });
  assert.equal(w12.title, 'END 100-99');
  assert.equal(w12.artist, '#81 TB S1-0 UE:3');

  const w11 = formatWristDisplay(manualTb, { maxTitleLen: 11, maxArtistLen: 20 });
  assert.equal(w11.title, 'END 100-99');
  assert.equal(w11.artist, '#81 TB S1-0 UE:3');

  const w10 = formatWristDisplay(manualTb, { maxTitleLen: 10, maxArtistLen: 20 });
  assert.equal(w10.title, 'END 100-99');
  assert.equal(w10.artist, '#81 TB S1-0 UE:3');

  // Active marathon TB compact form preserves serve marker when exact score overflows
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
