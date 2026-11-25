/* test-suite.js — Tests partagés entre tests.html (navigateur) et run-node.js (Node >= 18). */
(function (G) {
  'use strict';

  function makeAssert() {
    const fmt = (v) => (typeof v === 'bigint' ? v + 'n' : JSON.stringify(v));
    return {
      ok(c, msg) { if (!c) throw new Error('Échec : ' + (msg || 'condition fausse')); },
      eq(a, b, msg) {
        if (!(a === b || (typeof a === 'bigint' && typeof b === 'bigint' && a === b) || Object.is(a, b)))
          throw new Error(`${msg ? msg + ' : ' : ''}attendu ${fmt(b)}, obtenu ${fmt(a)}`);
      },
      deepEq(a, b, msg) {
        const s = (x) => JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? v + 'n' : v));
        if (s(a) !== s(b)) throw new Error(`${msg ? msg + ' : ' : ''}attendu ${s(b)}, obtenu ${s(a)}`);
      },
      bytes(a, b, msg) {
        const M = G.MarshalLib;
        if (!M.bytesEqual(a, b)) {
          let i = 0;
          while (i < a.length && i < b.length && a[i] === b[i]) i++;
          throw new Error(`${msg ? msg + ' : ' : ''}octets différents à l'offset ${i}\n  attendu ${M.toHex(b.subarray(i, i + 24))}\n  obtenu  ${M.toHex(a.subarray(i, i + 24))}`);
        }
      },
    };
  }

  const hexU8 = (h) => G.MarshalLib.parseHex(h);
  const splice = (orig, start, end, ins) => {
    const out = new Uint8Array(orig.length - (end - start) + ins.length);
    out.set(orig.subarray(0, start), 0);
    out.set(ins, start);
    out.set(orig.subarray(end), start + ins.length);
    return out;
  };

  function buildTests(M) {
    const T = [];
    const t = (name, fn) => T.push({ name, fn });
    const fx = (name) => G.MARSHAL_FIXTURES.find((f) => f.name.startsWith(name));
    const loadFx = (name) => {
      const bytes = hexU8(fx(name).hex);
      return { bytes, doc: M.load(bytes) };
    };

    // 1. Round-trip de chaque fixture
    for (const f of G.MARSHAL_FIXTURES) {
      t('round-trip : ' + f.name, (a) => {
        const bytes = hexU8(f.hex);
        const doc = M.load(bytes);
        if (f.check) f.check(doc.root, M, a, doc);
        const rt = M.roundTrip(doc);
        a.ok(rt.ok, `round-trip KO (premier écart à ${rt.firstDiff})`);
        a.bytes(M.dumpFile(doc), bytes, 'fichier complet');
      });
    }

    // 2. Formatage canonique (sans les octets bruts d'origine)
    t('formatFloat identique à Ruby', (a) => {
      const { bytes, doc } = loadFx('floats');
      doc.root.items.forEach((n) => delete n.raw);
      a.bytes(M.dump(doc.root), bytes);
      a.eq(M.formatFloat(120), '1.2e2');
      a.eq(M.formatFloat(1e16), '1e16');
      a.eq(M.formatFloat(12345), '12345');
      a.eq(M.formatFloat(0.0001), '0.0001');
      a.eq(M.formatFloat(-2.5e-7), '-2.5e-7');
    });
    t('bignums réencodés sans octets bruts', (a) => {
      const { bytes, doc } = loadFx('bignums');
      doc.root.items.forEach((n) => delete n.raw);
      a.bytes(M.dump(doc.root), bytes);
    });

    // 3. Éditions
    t('édition : max_potion 2 → 99 (cas d’usage PSDK)', (a) => {
      const { doc } = loadFx('sauvegarde PSDK');
      const items = doc.root.ivars[0][1].ivars[0][1];
      const entry = items.entries.find(([k]) => M.symName(k) === 'max_potion');
      const node = entry[1];
      M.setInt(node, 99);
      const expected = splice(doc.marshal, node._o, node._e, new Uint8Array([0x69, 0x68]));
      a.bytes(M.dump(doc.root), expected);
      const out = M.dumpFile(doc);
      a.eq(M.latin1(out.subarray(0, 5)), 'PKPRT', 'préfixe conservé');
      const re = M.load(out);
      a.eq(re.root.ivars[0][1].ivars[0][1].entries[1][1].v, 99);
      a.ok(re.root.ivars[8][1] === re.root.ivars[0][1], '@alias toujours partagé');
    });
    t('édition d’une chaîne partagée : le lien @ est conservé', (a) => {
      const { doc } = loadFx('références partagées');
      M.setStrText(doc.root.items[0], 'yz');
      a.bytes(M.dump(doc.root), hexU8('04 08 5b 08 49 22 07 79 7a 06 3a 06 45 54 40 06 40 00'));
    });
    t('entier promu en Bignum', (a) => {
      const { doc } = loadFx('fixnums');
      const n = doc.root.items[0];
      M.setInt(n, 2 ** 31);
      const expected = splice(doc.marshal, n._o, n._e, hexU8('6c 2b 07 00 00 00 80'));
      a.bytes(M.dump(doc.root), expected);
      a.eq(M.load(M.dump(doc.root)).root.items[0].v, 2 ** 31);
      M.setInt(n, M.parseIntText('-99999999999999999999'));
      a.eq(M.load(M.dump(doc.root)).root.items[0].v, -99999999999999999999n);
    });
    t('symbole renommé vers un symbole existant → symlink', (a) => {
      const { doc } = loadFx('symboles');
      M.setSymName(doc.root.items[3], 'foo');
      a.bytes(M.dump(doc.root), hexU8('04 08 5b 0a 3a 08 66 6f 6f 3b 00 49 3a 07 c3 a9 06 3a 06 45 54 3b 00 3b 06'));
    });
    t('suppression de la 1re occurrence d’un symbole UTF-8 → réécrit avec encodage', (a) => {
      const { doc } = loadFx('symboles');
      doc.root.items.splice(2, 1);
      a.bytes(M.dump(doc.root), hexU8('04 08 5b 09 3a 08 66 6f 6f 3b 00 3a 08 62 61 72 49 3a 07 c3 a9 06 3a 06 45 54'));
    });
    t('nouveau symbole non-ASCII', (a) => {
      const { doc } = loadFx('symboles');
      M.setSymName(doc.root.items[0], 'café');
      const re = M.load(M.dump(doc.root)).root;
      a.eq(M.symName(re.items[0]), 'café');
      a.eq(M.symName(re.items[1]), 'foo');
    });
    t('flottant modifié', (a) => {
      const { doc } = loadFx('flottant partagé');
      M.setFloat(doc.root.items[0], 2.25);
      a.bytes(M.dump(doc.root), hexU8('04 08 5b 07 66 09 32 2e 32 35 40 06'));
    });
    t('changement de type nil → entier', (a) => {
      const { doc } = loadFx('struct');
      const n = doc.root.members[1][1];
      M.replaceNode(n, { t: 'int', v: 7 });
      a.bytes(M.dump(doc.root), hexU8('04 08 53 3a 06 53 07 3a 06 61 69 06 3a 06 62 69 0c'));
    });
    t('ajout dans un hash avec clé symbole réutilisée', (a) => {
      const { doc } = loadFx('hash');
      doc.root.entries.push([M.mkSym('a'), { t: 'int', v: 3 }]);
      a.bytes(M.dump(doc.root), hexU8('04 08 7b 08 3a 06 61 69 06 49 22 06 62 06 3a 06 45 54 30 3b 00 69 08'));
    });
    t('Table : édition de cellule', (a) => {
      const { doc } = loadFx('RGSS');
      const tn = doc.root.items[0];
      tn.bytes = M.decoders.Table.set(tn.bytes, 2, 1, 0, 1234);
      const re = M.load(M.dump(doc.root)).root;
      a.eq(M.decoders.Table.decode(re.items[0].bytes).get(2, 1, 0), 1234);
      const c = doc.root.items[1];
      c.bytes = M.decoders.Color.encode([1, 2, 3, 4]);
      a.deepEq(M.decoders.Color.decode(M.load(M.dump(doc.root)).root.items[1].bytes), [1, 2, 3, 4]);
    });
    t('chaîne US-ASCII éditée en non-ASCII → E passe à true', (a) => {
      const { doc } = loadFx('chaînes');
      M.setStrText(doc.root.items[1], 'déjà');
      const re = M.load(M.dump(doc.root)).root;
      a.eq(M.strEncoding(re.items[1]), 'UTF-8');
      a.eq(M.strView(re.items[1]).text, 'déjà');
    });

    // 4. zlib
    t('Scripts.rxdata : décompression, édition, recompression', async (a) => {
      if (!M.zlib.available) return 'ignoré (DecompressionStream absent)';
      const { doc } = loadFx('Scripts');
      const n = await M.inflateScripts(doc.root);
      a.eq(n, 2);
      const s = doc.root.items[0].items[2];
      a.eq(s.zs.text, "p 'hello'");
      a.ok(M.roundTrip(doc).ok, 'round-trip intact après décompression');
      s.bytes = await M.zlib.deflate(M.encodeUtf8('puts "édité"'));
      s.zs = { text: 'puts "édité"' };
      const re = M.load(M.dump(doc.root));
      await M.inflateScripts(re.root);
      a.eq(re.root.items[0].items[2].zs.text, 'puts "édité"');
    });

    // 5. Erreurs
    t('erreur : données tronquées → offset', (a) => {
      try { M.load(hexU8('04 08 5b 07 69 06')); } catch (e) {
        a.eq(e.name, 'MarshalError'); a.eq(e.offset, 6); return;
      }
      throw new Error('aucune erreur levée');
    });
    t('erreur : type inconnu → offset + octet', (a) => {
      try { M.load(hexU8('04 08 5b 06 5a')); } catch (e) {
        a.eq(e.offset, 4); a.eq(e.typeByte, 0x5a); return;
      }
      throw new Error('aucune erreur levée');
    });
    t('erreur : signature absente', (a) => {
      try { M.load(hexU8('00 01 02 03')); } catch (e) { a.eq(e.name, 'MarshalError'); return; }
      throw new Error('aucune erreur levée');
    });

    // 6. Divers
    t('export JSON (cycles, partages)', (a) => {
      const { doc } = loadFx('références partagées');
      const j = JSON.parse(M.toJSON(doc.root));
      a.eq(j[0], 'x');
      a.ok(j[2].$ref !== undefined, '$ref présent');
      const p = loadFx('sauvegarde PSDK');
      JSON.parse(M.toJSON(p.doc.root));
    });
    return T;
  }

  /** Exécute les tests. log(name, ok, detail) est appelé pour chacun. */
  async function run(log) {
    const M = G.MarshalLib;
    const tests = buildTests(M);
    let pass = 0, fail = 0;
    for (const tc of tests) {
      try {
        const note = await tc.fn(makeAssert());
        pass++;
        log(tc.name, true, typeof note === 'string' ? note : '');
      } catch (e) {
        fail++;
        log(tc.name, false, e && e.stack ? e.message : String(e));
      }
    }
    return { pass, fail, total: tests.length };
  }

  /** Round-trip d'un fichier arbitraire (utilisé par tests.html pour les fichiers déposés). */
  function roundTripFile(bytes) {
    const M = G.MarshalLib;
    const doc = M.load(bytes);
    const rt = M.roundTrip(doc);
    const full = M.dumpFile(doc);
    return { ok: rt.ok && M.bytesEqual(full, bytes), rt, doc };
  }

  G.MarshalTests = { run, roundTripFile };
})(typeof window !== 'undefined' ? window : globalThis);
