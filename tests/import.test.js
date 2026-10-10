import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV } from '../src/csv.js';
import { parseHuckleberryCSV, parseDateTime, parseDuration, parseTimeOfDay } from '../src/huckleberry.js';
import { at, generateHistory, toHuckleberryCSV } from './helpers.js';

test('parseCSV handles quotes, embedded commas/newlines, BOM and CRLF', () => {
  const rows = parseCSV('﻿a,b,c\r\n1,"x, y","line1\nline2"\r\n"he said ""hi""",,3\r\n');
  assert.deepEqual(rows, [
    ['a', 'b', 'c'],
    ['1', 'x, y', 'line1\nline2'],
    ['he said "hi"', '', '3'],
  ]);
});

test('parseCSV detects semicolon and tab delimiters', () => {
  assert.deepEqual(parseCSV('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCSV('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
});

test('parseDateTime understands the common export formats', () => {
  const want = at(2026, 3, 7, 14, 5);
  assert.equal(parseDateTime('2026-03-07 14:05'), want);
  assert.equal(parseDateTime('2026-03-07T14:05:00'), want);
  assert.equal(parseDateTime('3/7/2026 2:05 PM'), want);
  assert.equal(parseDateTime('03/07/26 14:05'), want);
  assert.equal(parseDateTime('7/3/2026 14:05', 'dmy'), want);
  assert.equal(parseDateTime('12:30 AM', 'mdy'), null);
  assert.equal(parseDateTime('2026-03-07 12:30 AM'), at(2026, 3, 7, 0, 30));
  assert.equal(parseDateTime('2026-03-07 12:30 PM'), at(2026, 3, 7, 12, 30));
  assert.equal(parseDateTime('2026-02-31 10:00'), null);
  assert.equal(parseDateTime('garbage'), null);
  assert.equal(parseDateTime('2026-03-07T14:05:00Z'), Date.UTC(2026, 2, 7, 14, 5));
});

test('parseDuration and parseTimeOfDay', () => {
  assert.equal(parseDuration('01:23'), 83);
  assert.equal(parseDuration('1:23:30'), 83.5);
  assert.equal(parseDuration('1h 23m'), 83);
  assert.equal(parseDuration('45 min'), 45);
  assert.equal(parseDuration('2h'), 120);
  assert.equal(parseDuration('90'), 90);
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration('abc'), null);
  assert.equal(parseTimeOfDay('2:05 PM'), 14 * 60 + 5);
  assert.equal(parseTimeOfDay('00:10'), 10);
});

test('imports only Sleep rows from a Huckleberry-style export', () => {
  const csv = [
    'Start,End,Duration,Type,Start Condition,Start Location,End Condition,Notes',
    '2026-10-01 19:05,2026-10-02 06:40,11:35,Sleep,Rocked,Crib,Happy,',
    '2026-10-02 09:10,2026-10-02 10:20,01:10,Sleep,Fed to sleep,Crib,Woke up,"Teething, fussy"',
    '2026-10-02 10:30,,,Feed,Bottle,,,',
    '2026-10-02 10:45,,,Diaper,Pee,,,',
    '2026-10-02 12:00,,00:50,Sleep,,,,',
    '2026-10-02 13:00,,,Sleep,,,,',
    'oops,2026-10-02 13:00,,Sleep,,,,',
    '2026-10-02 09:10,2026-10-02 10:20,01:10,Sleep,,,,',
  ].join('\n');
  const r = parseHuckleberryCSV(csv);
  assert.ok(r.ok);
  assert.equal(r.sleeps.length, 3);
  assert.equal(r.stats.skippedNonSleep, 2);
  assert.equal(r.stats.skippedInvalid, 3);
  assert.deepEqual(
    r.sleeps.map((s) => s.kind),
    ['night', 'nap', 'nap'],
  );
  assert.equal(r.sleeps[1].notes, 'Teething, fussy');
  // End derived from Duration when End is blank.
  assert.equal(r.sleeps[2].end - r.sleeps[2].start, 50 * 60_000);
  assert.equal(r.stats.first, at(2026, 10, 1, 19, 5));
  assert.equal(r.stats.last, at(2026, 10, 2, 12, 50));
});

test('detects day-first dates from the data', () => {
  const csv = 'Start,End,Type\n25/12/2026 19:00,26/12/2026 06:30,Sleep\n';
  const r = parseHuckleberryCSV(csv);
  assert.equal(r.sleeps[0].start, at(2026, 12, 25, 19, 0));
});

test('supports a separate Date column with time-only Start/End', () => {
  const csv = 'Date,Start,End,Type\n2026-10-02,9:10 AM,10:20 AM,Sleep\n2026-10-02,7:00 PM,6:30 AM,Sleep\n';
  const r = parseHuckleberryCSV(csv);
  assert.equal(r.sleeps.length, 2);
  assert.equal(r.sleeps[0].end, at(2026, 10, 2, 10, 20));
  assert.equal(r.sleeps[1].end, at(2026, 10, 3, 6, 30));
});

test('reports a helpful error for files it cannot read', () => {
  const r = parseHuckleberryCSV('Foo,Bar\n1,2\n');
  assert.equal(r.ok, false);
  assert.match(r.error, /Foo, Bar/);
  assert.equal(parseHuckleberryCSV('Start,Type\n2026-01-01 10:00,Sleep\n').ok, false);
});

test('round-trips a generated export with unrelated rows mixed in', () => {
  const history = generateHistory({ endDay: at(2026, 10, 10), days: 30 });
  const r = parseHuckleberryCSV(toHuckleberryCSV(history));
  assert.ok(r.ok);
  assert.equal(r.sleeps.length, history.length);
  assert.ok(r.stats.skippedNonSleep > 0);
  assert.equal(r.stats.skippedInvalid, 0);
});
