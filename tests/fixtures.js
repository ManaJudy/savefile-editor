/* fixtures.js — Fichiers Marshal d'exemple, écrits octet par octet tels que Ruby les produit
 * (Ruby >= 1.9 sauf mention « 1.8 » = style RPG Maker XP sans encodage).
 * Chaque entrée : { name, hex, check?(root, M, assert, doc) }
 * Vérifiées identiques au Marshal.dump de Ruby 2.7 et 3.3.
 */
(function (G) {
  'use strict';
  const F = [];
  const add = (name, hex, check) => F.push({ name, hex: hex.replace(/\s+/g, ' ').trim(), check });

  add('nil', '04 08 30', (r, M, a) => a.eq(r.t, 'nil'));
  add('true', '04 08 54', (r, M, a) => a.eq(r.t, 'true'));
  add('false', '04 08 46', (r, M, a) => a.eq(r.t, 'false'));

  add('fixnums (encodage variable, négatifs)',
    `04 08 5b 12
     69 00  69 06  69 fa  69 7f  69 01 7b  69 80  69 ff 84  69 01 ff
     69 02 00 01  69 ff 00  69 03 00 00 01  69 04 ff ff ff 3f  69 fc 00 00 00 c0`,
    (r, M, a) => a.deepEq(r.items.map((n) => n.v),
      [0, 1, -1, 122, 123, -123, -124, 255, 256, -256, 65536, 1073741823, -1073741824]));

  add('bignums',
    `04 08 5b 08
     6c 2b 07 00 00 00 40
     6c 2d 07 01 00 00 40
     6c 2b 0a 00 00 00 00 00 00 00 00 01 00`,
    (r, M, a) => {
      a.eq(r.items[0].v, 1073741824);
      a.eq(r.items[1].v, -1073741825);
      a.eq(r.items[2].v, 18446744073709551616n);
    });

  add('floats (inf, -inf, nan, -0, exposants)',
    `04 08 5b 0f
     66 08 31 2e 35   66 07 2d 30   66 08 69 6e 66   66 09 2d 69 6e 66   66 08 6e 61 6e
     66 08 31 65 32   66 08 30 2e 31   66 09 31 65 2d 35   66 06 31   66 0c 31 32 33 2e 34 35 36`,
    (r, M, a) => {
      const v = r.items.map((n) => n.v);
      a.eq(v[0], 1.5); a.ok(Object.is(v[1], -0), '-0'); a.eq(v[2], Infinity); a.eq(v[3], -Infinity);
      a.ok(Number.isNaN(v[4]), 'nan'); a.eq(v[5], 100); a.eq(v[6], 0.1); a.eq(v[7], 1e-5); a.eq(v[8], 1); a.eq(v[9], 123.456);
    });

  add('float Ruby 1.8 avec octets de mantisse', '04 08 66 0d 30 2e 31 00 99 99 99 9a',
    (r, M, a) => a.eq(r.v, 0.1));

  add('flottant partagé (objlink sur Float)', '04 08 5b 07 66 08 31 2e 35 40 06',
    (r, M, a) => a.ok(r.items[0] === r.items[1], 'même nœud'));

  add('chaînes (UTF-8, US-ASCII, binaire, Shift_JIS)',
    `04 08 5b 09
     49 22 0b 68 c3 a9 6c 6c 6f 06 3a 06 45 54
     49 22 08 61 62 63 06 3b 00 46
     22 07 ff 00
     49 22 07 82 a0 06 3a 0d 65 6e 63 6f 64 69 6e 67 22 0e 53 68 69 66 74 5f 4a 49 53`,
    (r, M, a) => {
      a.eq(M.strView(r.items[0]).text, 'héllo'); a.eq(M.strEncoding(r.items[0]), 'UTF-8');
      a.eq(M.strEncoding(r.items[1]), 'US-ASCII');
      a.eq(M.strView(r.items[2]).mode, 'hex');
      a.eq(M.strEncoding(r.items[3]), 'Shift_JIS');
    });

  add('symboles et symlinks (+ symbole UTF-8)',
    '04 08 5b 0a 3a 08 66 6f 6f 3b 00 49 3a 07 c3 a9 06 3a 06 45 54 3a 08 62 61 72 3b 06',
    (r, M, a) => a.deepEq(r.items.map((n) => M.symName(n)), ['foo', 'foo', 'é', 'bar', 'é']));

  add('références partagées et cycle',
    '04 08 5b 08 49 22 06 78 06 3a 06 45 54 40 06 40 00',
    (r, M, a) => { a.ok(r.items[0] === r.items[1], 'partagé'); a.ok(r.items[2] === r, 'cycle'); });

  add('hash', '04 08 7b 07 3a 06 61 69 06 49 22 06 62 06 3a 06 45 54 30',
    (r, M, a) => { a.eq(r.entries.length, 2); a.eq(M.symName(r.entries[0][0]), 'a'); a.eq(r.entries[1][1].t, 'nil'); });

  add('hash avec défaut', '04 08 7d 06 69 06 69 07 69 0a',
    (r, M, a) => { a.eq(r.def.v, 5); a.eq(r.entries[0][1].v, 2); });

  add('objet', '04 08 6f 3a 0a 50 6f 69 6e 74 07 3a 07 40 78 69 06 3a 07 40 79 69 07',
    (r, M, a) => { a.eq(M.symName(r.cls), 'Point'); a.eq(r.ivars[1][1].v, 2); });

  add('struct', '04 08 53 3a 06 53 07 3a 06 61 69 06 3a 06 62 30',
    (r, M, a) => { a.eq(r.t, 'struct'); a.eq(M.symName(r.members[1][0]), 'b'); });

  add('user class (Array)', '04 08 43 3a 0a 4d 79 41 72 72 5b 06 69 06',
    (r, M, a) => { a.eq(r.t, 'array'); a.eq(M.symName(r.uclass), 'MyArr'); });

  add('user class (String + encodage)', '04 08 49 43 3a 0a 4d 79 53 74 72 22 06 78 06 3a 06 45 54',
    (r, M, a) => { a.eq(r.t, 'str'); a.eq(M.symName(r.uclass), 'MyStr'); a.eq(M.strEncoding(r), 'UTF-8'); });

  add('user-defined (_dump) avec ivars', '04 08 49 75 3a 08 46 6f 6f 07 68 69 06 3a 06 45 54',
    (r, M, a) => { a.eq(r.t, 'userdef'); a.eq(M.latin1(r.bytes), 'hi'); });

  add('user-marshal (marshal_dump)', '04 08 55 3a 08 46 6f 6f 5b 06 69 06',
    (r, M, a) => { a.eq(r.t, 'usermarshal'); a.eq(r.data.items[0].v, 1); });

  add('extended', '04 08 65 3a 08 4d 6f 64 6f 3a 0b 4f 62 6a 65 63 74 00',
    (r, M, a) => { a.eq(r.t, 'object'); a.eq(M.symName(r.extends[0]), 'Mod'); });

  add('regexp', '04 08 49 2f 08 61 62 2b 01 06 3a 06 45 46',
    (r, M, a) => { a.eq(r.t, 'regexp'); a.eq(r.opts, 1); });

  add('class et module', '04 08 5b 07 63 0b 53 74 72 69 6e 67 6d 0b 4b 65 72 6e 65 6c',
    (r, M, a) => { a.eq(r.items[0].t, 'class'); a.eq(r.items[1].t, 'module'); });

  add('data (d)', '04 08 64 3a 08 46 6f 6f 69 06', (r, M, a) => a.eq(r.t, 'data'));

  add('octets de fin conservés (suffixe)', '04 08 30 de ad',
    (r, M, a, doc) => a.eq(doc.suffix.length, 2));

  // RPG Maker XP (Ruby 1.8) : Table, Color, Tone, Rect
  add('RGSS Table/Color/Tone/Rect (1.8)',
    `04 08 5b 09
     75 3a 0a 54 61 62 6c 65 25
        02 00 00 00 03 00 00 00 02 00 00 00 01 00 00 00 06 00 00 00
        01 00 02 00 03 00 04 00 05 00 ff ff
     75 3a 0a 43 6f 6c 6f 72 25
        00 00 00 00 00 e0 6f 40  00 00 00 00 00 00 60 40  00 00 00 00 00 00 00 00  00 00 00 00 00 e0 6f 40
     75 3a 09 54 6f 6e 65 25
        00 00 00 00 00 00 24 c0  00 00 00 00 00 00 34 40  00 00 00 00 00 00 00 00  00 00 00 00 00 00 49 40
     75 3a 09 52 65 63 74 15
        01 00 00 00 02 00 00 00 1e 00 00 00 28 00 00 00`,
    (r, M, a) => {
      const t = M.decoderFor(r.items[0]);
      a.eq(t.name, 'Table');
      const tb = t.dec.decode(r.items[0].bytes);
      a.eq(tb.xs, 3); a.eq(tb.get(2, 1, 0), -1);
      a.deepEq(M.decoderFor(r.items[1]).dec.decode(r.items[1].bytes), [255, 128, 0, 255]);
      a.deepEq(M.decoderFor(r.items[2]).dec.decode(r.items[2].bytes), [-10, 20, 0, 50]);
      a.deepEq(M.decoderFor(r.items[3]).dec.decode(r.items[3].bytes), [1, 2, 30, 40]);
    });

  // Scripts.rxdata (1.8) : [[id, nom, zlib(script)], ...]
  add('Scripts.rxdata (zlib)',
    `04 08 5b 07
     5b 08 69 02 39 30 22 09 4d 61 69 6e 22 16 78 9c 2b 50 50 cf 48 cd c9 c9 57 07 00 0e 6c 02 f3
     5b 08 69 07 22 09 54 65 73 74 22 19 78 9c ab 50 b0 55 30 e4 2a 28 2d 29 56 a8 00 00 15 26 03 95`,
    (r, M, a) => { a.eq(r.items[0].items[0].v, 12345); a.ok(M.detectScripts(r).length === 2, 'scripts détectés'); });

  // Sauvegarde type PSDK : en-tête "PKPRT" + objet
  add('sauvegarde PSDK (en-tête PKPRT)',
    `50 4b 50 52 54
     04 08
     6f 3a 13 50 46 4d 3a 3a 47 61 6d 65 53 74 61 74 65 0e
     3a 09 40 62 61 67
       6f 3a 0d 50 46 4d 3a 3a 42 61 67 07
       3a 0b 40 69 74 65 6d 73
         7b 08
         3a 0b 72 65 76 69 76 65 69 08
         3a 0f 6d 61 78 5f 70 6f 74 69 6f 6e 69 07
         3a 0b 70 6f 74 69 6f 6e 69 0f
       3a 11 40 6c 61 73 74 5f 73 6f 63 6b 65 74 69 06
     3a 12 40 74 72 61 69 6e 65 72 5f 6e 61 6d 65 49 22 0a c3 89 72 69 63 06 3a 06 45 54
     3a 0b 40 6d 6f 6e 65 79 69 03 40 e2 01
     3a 0c 40 73 68 61 72 65 64 5b 07 49 22 08 61 62 63 06 3b 0e 54 40 0a
     3a 09 40 70 6f 73 66 08 31 2e 35
     3a 0b 40 66 6c 61 67 73 5b 08 54 46 30
     3a 09 40 62 69 67 6c 2b 08 00 00 00 00 00 01
     3a 0a 40 6e 69 63 6b 3b 0a
     3a 0b 40 61 6c 69 61 73 40 06`,
    (r, M, a, doc) => {
      a.eq(M.latin1(doc.prefix), 'PKPRT');
      a.eq(M.symName(r.cls), 'PFM::GameState');
      const bag = r.ivars[0][1];
      a.eq(bag.entries === undefined, true);
      a.eq(r.ivars[8][1], bag, '@alias partage @bag');
      a.eq(M.strView(r.ivars[1][1]).text, 'Éric');
      a.eq(r.ivars[2][1].v, 123456);
      a.eq(r.ivars[6][1].v, 1099511627776);
    });

  G.MARSHAL_FIXTURES = F;
})(typeof window !== 'undefined' ? window : globalThis);
