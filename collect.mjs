// 신약 레이더 - 수집 스크립트
// 하는 일
//   1. 식약처 허가 목록 전체(약 4.3만 건)를 훑어서 최근 기간 안에 허가된 약을 찾아요.
//   2. 그 약들의 상세 정보(ATC 코드, 신약 구분, 효능효과)를 받아서 비만·탈모·안과(노안·근시) 약만 골라요.
//   3. 미국 FDA에서 같은 기간 최초 승인된 신약(신물질·바이오)을 찾고, 허가 문서의 적응증으로 같은 분야만 골라요.
//   4. 결과를 data 폴더에 저장하고 화면에 요약을 보여줘요.
// 실행: node collect.mjs        (최근 365일)
//       node collect.mjs 30     (최근 30일)

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, "data");
const cachePath = path.join(dataDir, "kr-detail-cache.json");

const DAYS = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 365;
const MFDS = "https://apis.data.go.kr/1471000/DrugPrdtPrmsnInfoService08";
const ROWS = 100;
const CONCURRENCY = 3;
const CACHE_V = 2;

// ---------- 공통 도구 ----------
const log = (t = "") => console.log(t);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, "");
const today = new Date();
const since = ymd(new Date(today.getTime() - DAYS * 86400000));
const until = ymd(today);

function stripXml(s) {
  if (!s) return "";
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, " $1 ")
    .replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchJson(url, label, tries = 4) {
  let lastErr = "";
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { lastErr = `JSON 아님: ${text.slice(0, 200)}`; }
      if (json) {
        const code = json?.header?.resultCode ?? json?.response?.header?.resultCode;
        if (code && code !== "00") {
          lastErr = `결과코드 ${code} ${json?.header?.resultMsg ?? ""}`;
          if (code === "22") throw new Error("오늘 호출 허용량을 넘었어요. 내일 다시 실행해 주세요.");
        } else {
          return json;
        }
      }
    } catch (e) {
      if (String(e.message).includes("허용량")) throw e;
      lastErr = e.message;
    }
    await sleep(800 * (i + 1));
  }
  throw new Error(`${label} 실패: ${lastErr}`);
}

function pickItems(json) {
  const body = json?.body ?? json?.response?.body;
  let items = body?.items;
  if (items && !Array.isArray(items)) items = items.item ?? items;
  if (items && !Array.isArray(items)) items = [items];
  return { body, items: items ?? [] };
}

async function pool(list, n, worker) {
  const out = new Array(list.length);
  let next = 0;
  async function run() {
    while (next < list.length) {
      const i = next++;
      out[i] = await worker(list[i], i);
    }
  }
  await Promise.all(Array.from({ length: n }, run));
  return out;
}

// ---------- 분야 판정 ----------
// 개원가 비급여 진료에서 많이 다루는 분야예요. 순서가 화면의 칩 순서가 돼요.
const CATEGORIES = ["비만", "탈모", "피부·미용", "안과", "남성 건강", "여성 건강", "예방접종", "성장"];

// 국내: ATC 코드와 효능효과 문구로 판단
function classifyKr(atc, ee) {
  const cats = [];
  if (/^A08/.test(atc) || /비만|체중\s*(감량|관리|감소)/.test(ee)) cats.push("비만");
  if (/^D11AX(01|10)/.test(atc) || /탈모/.test(ee)) cats.push("탈모");
  if (/미간\s*주름|눈가\s*주름|이마\s*주름|주름(의)?\s*(일시적\s*)?개선|여드름|기미|다한증|턱\s*밑\s*지방|턱밑\s*지방|셀룰라이트/.test(ee)) cats.push("피부·미용");
  if (/노안|근시(?!성)/.test(ee)) cats.push("안과");
  if (/발기부전|발기\s*부전|조루|남성\s*갱년기|테스토스테론\s*(결핍|저하)|남성\s*성선\s*기능\s*저하/.test(ee)) cats.push("남성 건강");
  if (/피임|안면\s*홍조|혈관\s*운동\s*증상|(폐경|갱년기)\S*\s*(증상|여성의\s*증상)/.test(ee)) cats.push("여성 건강");
  if (/예방/.test(ee) && /대상포진|인유두종|HPV|호흡기\s*세포\s*융합|RSV|폐렴구균|수막구균/.test(ee)) cats.push("예방접종");
  if (/성장\s*호르몬\s*결핍|저신장|성장\s*부전/.test(ee)) cats.push("성장");
  return cats;
}
// 미국: 허가 문서의 적응증 문구로 판단
function classifyUs(ind) {
  const t = String(ind).toLowerCase();
  const cats = [];
  if (/chronic weight management|obesity|overweight/.test(t)) cats.push("비만");
  if (/alopecia|hair loss/.test(t)) cats.push("탈모");
  if (/glabellar|lateral canthal|forehead lines|wrinkle|acne(?! inversa)|melasma|hyperhidrosis|submental fat|cellulite/.test(t)) cats.push("피부·미용");
  if (/presbyopia|myopia/.test(t)) cats.push("안과");
  if (/erectile dysfunction|premature ejaculation|testosterone (deficiency|replacement)|male hypogonadism/.test(t) && !/hypogonadotropic|follitropin/.test(t)) cats.push("남성 건강");
  if (/contracepti|prevention of pregnancy|prevent pregnancy|vasomotor symptoms|hot flash|hot flush/.test(t)) cats.push("여성 건강");
  if (/(prevent|immuniz|vaccin)/.test(t) && /zoster|shingles|papillomavirus|respiratory syncytial|rsv|pneumococcal|meningococcal/.test(t)) cats.push("예방접종");
  if (/growth hormone deficiency|short stature|growth failure/.test(t)) cats.push("성장");
  return cats;
}

// ---------- 식약처 ----------
const krIndex = { combo: {}, single: {} };

async function collectKr(key) {
  log(`\n==== 식약처: ${since} ~ ${until} 허가 찾기 ====`);
  const listUrl = p => `${MFDS}/getDrugPrdtPrmsnInq08?${new URLSearchParams({ serviceKey: key, type: "json", pageNo: String(p), numOfRows: String(ROWS) })}`;
  const first = await fetchJson(listUrl(1), "목록 1페이지");
  const { body, items: firstItems } = pickItems(first);
  const total = Number(body?.totalCount || 0);
  const pages = Math.ceil(total / ROWS);
  log(`전체 ${total}건, ${pages}페이지를 읽어요. 몇 분 걸려요.`);

  const recent = [];
  // 성분 + 제품 분류(예: 바르는 탈모약 vs 먹는 약) 조합별로
  //   처음 허가된 날짜, 처음 허가받은 회사, 이번 기간 전에 허가받은 회사들을 기록해요
  const keyInfo = {};
  const oldItems = {};
  const take = items => items.forEach(it => {
    const bases = String(it.ITEM_INGR_NAME ?? "").split("/").map(baseName).filter(Boolean);
    if (bases.length) {
      const d0 = String(it.ITEM_PERMIT_DATE || "99999999");
      const combo = [...new Set(bases)].sort().join("+");
      if (!krIndex.combo[combo] || d0 < krIndex.combo[combo]) krIndex.combo[combo] = d0;
      bases.forEach(b => { if (!krIndex.single[b] || d0 < krIndex.single[b]) krIndex.single[b] = d0; });
    }
    const k = ingrKey(it);
    const dte = String(it.ITEM_PERMIT_DATE || "99999999");
    if (k) {
      const info = (keyInfo[k] ??= { first: "99999999", firstCompany: "", prior: new Set() });
      if (dte < info.first) { info.first = dte; info.firstCompany = it.ENTP_NAME; }
      if (dte < since) {
        info.prior.add(it.ENTP_NAME);
        (oldItems[k] ??= []).push({ seq: String(it.ITEM_SEQ), date: dte });
      }
    }
    if (dte >= since && it.CANCEL_NAME === "정상") recent.push(it);
  });
  take(firstItems);

  let done = 1;
  await pool(Array.from({ length: pages - 1 }, (_, i) => i + 2), CONCURRENCY, async p => {
    const j = await fetchJson(listUrl(p), `목록 ${p}페이지`);
    take(pickItems(j).items);
    done++;
    if (done % 50 === 0 || done === pages) log(`  목록 ${done}/${pages}페이지 완료, 지금까지 기간 내 허가 ${recent.length}건`);
  });

  // 상세 정보: 한 번 받은 건 캐시에 저장해 다음 실행 때 다시 부르지 않아요
  // 캐시 버전이 다르면(효능효과 읽는 방식이 바뀌었을 때) 새로 받아요
  let cache = {};
  try { cache = JSON.parse(await readFile(cachePath, "utf8")); } catch { /* 처음 실행 */ }
  if (cache.__v !== CACHE_V) cache = { __v: CACHE_V };

  async function fetchDetails(seqs, label) {
    const need = seqs.filter(q => !cache[q]);
    log(`\n${label}: ${seqs.length}건 중 상세 정보를 새로 받을 약 ${need.length}건`);
    let d = 0;
    await pool(need, CONCURRENCY, async q => {
      const url = `${MFDS}/getDrugPrdtPrmsnDtlInq08?${new URLSearchParams({ serviceKey: key, type: "json", pageNo: "1", numOfRows: "1", item_seq: q })}`;
      try {
        const j = await fetchJson(url, `상세 ${q}`);
        const x = pickItems(j).items[0] ?? {};
        cache[q] = {
          atc: x.ATC_CODE ?? "",
          newdrug: x.NEWDRUG_CLASS_NAME ?? "",
          ee: stripXml(x.EE_DOC_DATA).slice(0, 1500)
        };
      } catch (e) {
        if (String(e.message).includes("허용량")) throw e;
        log(`  상세 실패 ${q}: ${e.message}`);
      }
      d++;
      if (d % 100 === 0 || d === need.length) log(`  상세 ${d}/${need.length}건 완료`);
    });
    await writeFile(cachePath, JSON.stringify(cache), "utf8");
  }

  await fetchDetails(recent.map(it => String(it.ITEM_SEQ)), "기간 내 허가");

  const all = recent.map(it => {
    const c = cache[it.ITEM_SEQ] ?? {};
    return {
      item_seq: String(it.ITEM_SEQ),
      name: it.ITEM_NAME,
      company: it.ENTP_NAME,
      permit_date: String(it.ITEM_PERMIT_DATE),
      spclty: it.SPCLTY_PBLC,
      ingr: it.ITEM_INGR_NAME,
      atc: c.atc ?? "",
      newdrug: c.newdrug ?? "",
      categories: classifyKr(c.atc ?? "", c.ee ?? ""),
      ee: c.ee ?? "",
      ee_len: (c.ee ?? "").length,
      prdtype: it.PRDUCT_TYPE ?? "",
      ingr_cnt: Number(it.ITEM_INGR_CNT || 0),
      key: ingrKey(it),
      key_first: keyInfo[ingrKey(it)]?.first ?? "",
      originator: keyInfo[ingrKey(it)]?.firstCompany ?? "",
      prior_companies: [...(keyInfo[ingrKey(it)]?.prior ?? [])]
    };
  }).sort((a, b) => b.permit_date.localeCompare(a.permit_date));

  const oldKeys = [...new Set(all.filter(x => x.categories.length && x.key_first && x.key_first < since && !isHerbal(x)).map(x => x.key))];
  const checkSeqs = oldKeys.flatMap(k => (oldItems[k] ?? []).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 40).map(o => o.seq));
  await fetchDetails(checkSeqs, "예전 제품 효능효과 확인");
  const hadCat = {};
  oldKeys.forEach(k => {
    hadCat[k] = new Set();
    (oldItems[k] ?? []).forEach(o => {
      const c = cache[o.seq];
      if (c) classifyKr(c.atc ?? "", c.ee ?? "").forEach(cat => hadCat[k].add(cat));
    });
  });
  all.forEach(x => {
    x.new_indication = !!(hadCat[x.key] && x.categories.some(cat => !hadCat[x.key].has(cat)));
  });

  return all;
}

function normIngr(name) {
  return String(name).toLowerCase()
    .replace(/\b(mono|di|tri|hemi|sesqui)?hydrate\b/g, "")
    .replace(/\banhydrous\b/g, "")
    .replace(/\s+/g, " ").trim();
}
// 성분의 기본 이름(염 표기를 뺀 첫 단어): "Brimonidine Tartrate" → "brimonidine"
function baseName(name) {
  return normIngr(name).replace(/^[^a-z]+/, "").split(" ")[0] ?? "";
}

function ingrKey(it) {
  const ingr = String(it.ITEM_INGR_NAME ?? "").split("/").map(normIngr).filter(Boolean).sort().join("/");
  const type = (String(it.PRDUCT_TYPE ?? "").match(/\[(\d+)\]/) ?? [])[1] ?? "";
  return ingr ? `${ingr}|${type}` : "";
}

// 한약(생약) 제제는 성분 조합이 제품마다 달라 "첫 등장"으로 잘못 잡히기 쉬워서 따로 빼요
function isHerbal(x) {
  return /한방|생약|한약/.test(x.prdtype) || x.ingr_cnt >= 5;
}

// 같은 회사·같은 성분의 용량별 제품을 하나로 묶어요
function groupByCompany(list) {
  const groups = {};
  for (const x of list) {
    const g = `${x.company}|${x.key}`;
    if (!groups[g]) groups[g] = { ...x, strengths: [] };
    groups[g].strengths.push(x.name);
    if (x.permit_date < groups[g].permit_date) groups[g].permit_date = x.permit_date;
  }
  return Object.values(groups);
}

function ingrLabel(x) {
  return (x.ingr || x.key.split("|")[0]).split("/").slice(0, 3).join(" + ");
}

// 국내 결과를 세 갈래로 나눠요
//   신약·첫 등장: 신약이거나, 성분+분류 조합이 이번 기간에 국내 처음 나온 약
//   첫 제네릭:   그동안 한 회사(오리지널)만 갖고 있던 성분에 다른 회사가 처음 들어온 경우
//   복제약 흐름: 이미 여러 회사가 있는 성분에 또 추가된 경우는 성분별 숫자로만
function splitKr(all) {
  const inCat = all.filter(x => x.categories.length && x.spclty === "전문의약품");
  const herbal = inCat.filter(isHerbal);
  const pool = inCat.filter(x => !isHerbal(x));

  const isNewOne = x => x.newdrug === "신약" || (x.key_first && x.key_first >= since) || x.new_indication;
  const isFirstGeneric = x => !isNewOne(x) && x.prior_companies.length === 1 && !x.prior_companies.includes(x.company);

  // 신약·첫 등장: 성분별로 가장 먼저 허가된 회사 카드 하나 + 뒤따라 허가된 회사
  const byKey = {};
  groupByCompany(pool.filter(isNewOne)).forEach(g => { (byKey[g.key] ??= []).push(g); });
  const newOnes = Object.values(byKey).map(list => {
    list.sort((a, b) => a.permit_date.localeCompare(b.permit_date));
    return { ...list[0], followers: list.slice(1).map(g => `${g.company} ${g.permit_date}`) };
  });

  // 첫 제네릭: 성분별 카드 하나에 이번 기간 들어온 회사들을 모아요
  const fgByKey = {};
  groupByCompany(pool.filter(isFirstGeneric)).forEach(g => { (fgByKey[g.key] ??= []).push(g); });
  const firstGenerics = Object.values(fgByKey).map(list => {
    list.sort((a, b) => a.permit_date.localeCompare(b.permit_date));
    const f = list[0];
    return {
      ingredient: ingrLabel(f), key: f.key, categories: f.categories, atc: f.atc,
      originator: f.prior_companies[0], first_date: f.permit_date,
      entrants: list.map(g => ({ company: g.company, date: g.permit_date, name: g.strengths[0] }))
    };
  });

  // 복제약 흐름: 성분별로 이번 기간 허가 건수와 회사 수
  const trendByKey = {};
  pool.filter(x => !isNewOne(x) && !isFirstGeneric(x)).forEach(x => {
    const t = (trendByKey[x.key] ??= { ingredient: ingrLabel(x), categories: x.categories, products: 0, companies: new Set(), latest: "" });
    t.products++; t.companies.add(x.company);
    if (x.permit_date > t.latest) t.latest = x.permit_date;
  });
  const trend = Object.values(trendByKey)
    .map(t => ({ ...t, companies: t.companies.size }))
    .sort((a, b) => b.companies - a.companies || b.products - a.products);

  const byDate = (a, b) => (b.permit_date || b.first_date).localeCompare(a.permit_date || a.first_date);
  return { newOnes: newOnes.sort(byDate), firstGenerics: firstGenerics.sort(byDate), trend, herbalCount: herbal.length };
}

// ---------- 미국 FDA ----------
async function collectUs() {
  log(`\n==== 미국 FDA: ${since} ~ ${until} 최초 승인 찾기 ====`);
  const search = `submissions.submission_type:"ORIG" AND submissions.submission_status:"AP" AND submissions.submission_status_date:[${since} TO ${until}]`;
  const results = [];
  for (let skip = 0; ; skip += 1000) {
    const url = `https://api.fda.gov/drug/drugsfda.json?search=${encodeURIComponent(search)}&limit=1000&skip=${skip}`;
    const j = await fetchJson(url, `FDA 목록 skip ${skip}`);
    results.push(...(j.results ?? []));
    const total = j.meta?.results?.total ?? 0;
    if (results.length >= total || !(j.results ?? []).length) break;
    await sleep(300);
  }

  // 같은 신청 안에서 최초 신청(ORIG)이 기간 안에 승인된 신약 신청(NDA)·바이오(BLA)만 남겨요
  const nme = [];
  for (const r of results) {
    const app = r.application_number ?? "";
    if (!/^(NDA|BLA)/.test(app)) continue;
    const orig = (r.submissions ?? []).find(s =>
      s.submission_type === "ORIG" && s.submission_status === "AP" &&
      s.submission_status_date >= since && s.submission_status_date <= until);
    if (!orig) continue;
    const cls = orig.submission_class_code ?? "";
    const prod = r.products?.[0] ?? {};
    nme.push({
      application: app,
      brand: prod.brand_name ?? "",
      ingredients: (prod.active_ingredients ?? []).map(a => a.name).join(" + "),
      sponsor: r.sponsor_name ?? "",
      approval_date: orig.submission_status_date,
      class_code: cls
    });
  }
  log(`최초 승인 기록 ${results.length}건 중 신약 신청(NDA·BLA) ${nme.length}건. 적응증을 확인해요.`);

  await pool(nme, 2, async n => {
    const url = `https://api.fda.gov/drug/label.json?search=${encodeURIComponent(`openfda.application_number:"${n.application}"`)}&limit=1`;
    try {
      const j = await fetchJson(url, `라벨 ${n.application}`, 2);
      n.indication = stripXml((j.results?.[0]?.indications_and_usage ?? []).join(" ")).slice(0, 1500);
    } catch { n.indication = ""; }
    if (!n.indication && n.brand) {
      try {
        const u2 = `https://api.fda.gov/drug/label.json?search=${encodeURIComponent(`openfda.brand_name:"${n.brand}"`)}&limit=1`;
        const j2 = await fetchJson(u2, `라벨 ${n.brand}`, 2);
        n.indication = stripXml((j2.results?.[0]?.indications_and_usage ?? []).join(" ")).slice(0, 1500);
      } catch { /* 그래도 없으면 비워 둬요 */ }
    }
    n.categories = classifyUs(n.indication);
    const bases = [...new Set(n.ingredients.split(" + ").map(baseName).filter(Boolean))].sort();
    const comboDate = krIndex.combo[bases.join("+")];
    if (!Object.keys(krIndex.single).length) n.kr_status = "unknown";
    else if (comboDate) { n.kr_status = "same"; n.kr_first = comboDate; }
    else if (bases.every(b => krIndex.single[b])) n.kr_status = "parts";
    else n.kr_status = "none";
    await sleep(250);
  });

  return nme.sort((a, b) => b.approval_date.localeCompare(a.approval_date));
}


// ---------- 임상 3상 (ClinicalTrials.gov) ----------
// 분야별 검색어. 이 검색어로 찾은 3상 시험의 분야를 정해요.
const CT_TERMS = {
  "비만": ["obesity", "overweight"],
  "탈모": ["androgenetic alopecia", "alopecia areata", "hair loss"],
  "피부·미용": ["glabellar lines", "facial wrinkles", "acne vulgaris", "melasma", "hyperhidrosis", "submental fat"],
  "안과": ["presbyopia", "myopia"],
  "남성 건강": ["erectile dysfunction", "premature ejaculation", "hypogonadism"],
  "여성 건강": ["contraception", "vasomotor symptoms", "menopause"],
  "성장": ["growth hormone deficiency", "short stature"]
};
// 백신은 이미 나온 제품이 비교·동시 접종용으로 잔뜩 섞여서 미국 임상에서는 빼요 (국내 임상·허가, 유럽에서 다뤄요)
const NOT_DRUG = /placeb|saline|vehicle|sham|standard|usual care|diet|exercise|lifestyle|counsel|no intervention|comparator|licensed|marketed|vaccin|toxoid|experimental drug|investigational product|aromatase inhibitor|supplement/i;
// 백신은 FDA 의약품 승인 데이터에 없어서, 이미 나와 있는 백신이 비교 대상으로 섞이지 않게 이름으로 걸러요
const APPROVED_VACCINES = /\b(prevnar|prevenar|pcv ?13|pcv ?15|pcv ?20|pneumovax|ppsv ?23|vaxneuvance|capvaxive|shingrix|zostavax|gardasil|cervarix|arexvy|abrysvo|mresvia|menveo|bexsero|trumenba|nimenrix|menquadfi|penbraya|penmenvy|synflorix)\b/i;

// 용량·제형·투여 횟수 표기를 떼고 약 이름만 남겨요: "KX-826 0.5% BID" → "kx-826", "CKD-843 dose#1" → "ckd-843"
const DESCRIPTORS = /^(low|lower|high|higher|dose|doses|oral|topical|injection|injectable|cream|gel|solution|ophthalmic|eye|drops?|tablets?|capsules?|foam|lotion|spray|patch|implant|extended|release|once|daily|weekly|qd|bid|tid|qw|and|with|the|for|of|a|an|plus)$/i;
function drugKey(name) {
  const t = String(name).toLowerCase().replace(/[®™]|tm\b/g, " ").replace(/\(.*?\)/g, " ").replace(/\+.*$/, " ")
    .replace(/[\d.]+\s*(mg|mcg|µg|ug|g|ml|%|iu|units?|u)\b/gi, " ").replace(/dose\s*#?\d+/gi, " ")
    .replace(/\b([a-z]{2,5})\s+(\d{2,})\b/g, "$1-$2")
    .split(/\s+/).filter(w => w && !DESCRIPTORS.test(w) && !/^[\d.%]+$/.test(w));
  if (!t.length) return "";
  // 코드명(숫자가 섞인 이름)은 첫 단어만, 일반 이름은 앞 두 단어까지
  const first = t[0].replace(/-(p\d+|r)$/i, "");
  return /\d/.test(first) ? first : t.slice(0, 2).join(" ");
}

async function ctSearch(term) {
  const statuses = "RECRUITING,ACTIVE_NOT_RECRUITING,NOT_YET_RECRUITING,ENROLLING_BY_INVITATION,COMPLETED";
  const fields = [
    "protocolSection.identificationModule", "protocolSection.statusModule",
    "protocolSection.sponsorCollaboratorsModule.leadSponsor", "protocolSection.designModule",
    "protocolSection.armsInterventionsModule.interventions", "protocolSection.conditionsModule.conditions"
  ].join(",");
  const out = [];
  let token = "";
  for (let page = 0; page < 3; page++) {
    const p = new URLSearchParams({ "query.cond": term, "filter.overallStatus": statuses, pageSize: "200", fields });
    if (token) p.set("pageToken", token);
    let j;
    try { j = await fetchJson(`https://clinicaltrials.gov/api/v2/studies?${p}`, `임상 검색 ${term}`, 3); }
    catch (e) {
      p.delete("fields"); p.set("pageSize", "50");
      j = await fetchJson(`https://clinicaltrials.gov/api/v2/studies?${p}`, `임상 검색 ${term} (간단히)`, 3);
    }
    out.push(...(j.studies ?? []));
    token = j.nextPageToken;
    if (!token) break;
    await sleep(300);
  }
  return out;
}

async function collectTrials(approvedBases = new Set()) {
  log(`\n==== 임상 3상 (ClinicalTrials.gov) ====`);
  const twoYearsAgo = new Date(today.getTime() - 730 * 86400000).toISOString().slice(0, 10);
  const drugs = {};
  for (const [cat, terms] of Object.entries(CT_TERMS)) {
    for (const term of terms) {
      let studies = [];
      try { studies = await ctSearch(term); } catch (e) { log(`  ${term}: 실패 ${e.message}`); continue; }
      let used = 0;
      for (const st of studies) {
        const ps = st.protocolSection ?? {};
        const phases = ps.designModule?.phases ?? [];
        if (!phases.includes("PHASE3")) continue;
        if (ps.designModule?.studyType && ps.designModule.studyType !== "INTERVENTIONAL") continue;
        if (ps.sponsorCollaboratorsModule?.leadSponsor?.class !== "INDUSTRY") continue;
        const status = ps.statusModule?.overallStatus ?? "";
        const done = ps.statusModule?.completionDateStruct?.date ?? ps.statusModule?.primaryCompletionDateStruct?.date ?? "";
        if (status === "COMPLETED" && done && done < twoYearsAgo) continue;
        const ivs = (ps.armsInterventionsModule?.interventions ?? [])
          .filter(iv => ["DRUG", "BIOLOGICAL", "COMBINATION_PRODUCT"].includes(iv.type) && !NOT_DRUG.test(iv.name ?? "") && !APPROVED_VACCINES.test(iv.name ?? ""));
        for (const iv of ivs) {
          const k = drugKey(iv.name);
          if (!k || k.length < 3) continue;
          const d = (drugs[k] ??= { name: iv.name.replace(/\(.*?\)/g, "").trim(), key: k, categories: new Set(), sponsors: new Set(), conditions: new Set(), trials: [] });
          d.categories.add(cat);
          d.sponsors.add(ps.sponsorCollaboratorsModule?.leadSponsor?.name ?? "");
          (ps.conditionsModule?.conditions ?? []).slice(0, 3).forEach(c => d.conditions.add(c));
          const id = ps.identificationModule?.nctId;
          if (!d.trials.some(t => t.id === id)) d.trials.push({ id, status, done, title: ps.identificationModule?.briefTitle ?? "" });
          used++;
        }
      }
      log(`  ${cat} / ${term}: 시험 ${studies.length}건 확인, 약 ${used}건 반영`);
      await sleep(300);
    }
  }

  // 이미 FDA 승인된 성분은 빼요 (비교약으로 들어간 기존 약이 섞이는 것도 여기서 걸러져요)
  const list = Object.values(drugs);
  log(`후보 약 ${list.length}개. 이미 승인된 약인지 확인해요.`);
  for (const d of list) {
    const b = d.key.split(" ")[0];
    d.approved = approvedBases.has(b) || await fdaApproved(b) || await fdaBrand(b);
  }

  return list.filter(d => !d.approved).map(d => {
    const active = d.trials.some(t => t.status !== "COMPLETED");
    const lastDone = d.trials.map(t => t.done).filter(Boolean).sort().pop() ?? "";
    const base = baseName(d.name);
    return {
      name: /\d/.test(d.key) ? d.key.toUpperCase() : d.key.replace(/\b[a-z]/g, c => c.toUpperCase()), categories: [...d.categories], sponsors: [...d.sponsors].filter(Boolean),
      conditions: [...d.conditions].slice(0, 5), trials: d.trials.slice(0, 10), trial_count: d.trials.length,
      stage: active ? "phase3_active" : "phase3_done", last_done: lastDone,
      kr_status: !Object.keys(krIndex.single).length ? "unknown" : (krIndex.single[base] ? "same" : "none"),
      kr_first: krIndex.single[base] ?? ""
    };
  }).sort((a, b) => b.trial_count - a.trial_count);
}

// ---------- 국내 임상시험 계획 (항목 확인용) ----------
async function probeKrTrials(key) {
  log(`\n==== 국내 임상시험 계획 (항목 확인) ====`);
  const base = "https://apis.data.go.kr/1471000/ClncExamPlanDtlService03";
  for (const op of ["getClncExamPlanDtlInq03", "getClncExamPlanDtlInq02", "getClncExamPlanDtlInq"]) {
    const url = `${base}/${op}?${new URLSearchParams({ serviceKey: key, type: "json", pageNo: "1", numOfRows: "2" })}`;
    try {
      const res = await fetch(url);
      const text = await res.text();
      let j = null; try { j = JSON.parse(text); } catch {}
      const items = j ? pickItems(j).items : [];
      if (items.length) {
        log(`작동하는 이름: ${op}, 전체 ${pickItems(j).body?.totalCount ?? "?"}건`);
        for (const [k, v] of Object.entries(items[0])) log(`  ${k}: ${String(v ?? "").slice(0, 60)}`);
        return;
      }
      log(`${op}: ${res.status} ${text.slice(0, 120).replace(/\s+/g, " ")}`);
    } catch (e) { log(`${op}: ${e.message}`); }
  }
  log("국내 임상 정보를 받지 못했어요. 공공데이터포털에서 '의약품 임상시험 계획 상세정보' 활용신청이 필요할 수 있어요.");
}


// ---------- 공통 도구 2 ----------
const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
function parseDate(v) {
  const s = String(v ?? "").trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return m[1] + m[2] + m[3];
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return s;
  if ((m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/))) return m[3] + m[2] + m[1];
  if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/))) return m[3] + String(MONTHS[m[2].toLowerCase()] ?? 0).padStart(2, "0") + m[1].padStart(2, "0");
  const d = new Date(s);
  return isNaN(d) ? "" : ymd(d);
}
const fdaCache = {};
const brandCache = {};
async function fdaBrand(word) {
  if (!word || /\d/.test(word)) return false;
  if (word in brandCache) return brandCache[word];
  try {
    const j = await fetchJson(`https://api.fda.gov/drug/drugsfda.json?search=${encodeURIComponent(`openfda.brand_name:"${word}"`)}&limit=1`, `상표 확인 ${word}`, 2);
    brandCache[word] = (j.results ?? []).length > 0;
  } catch { brandCache[word] = false; }
  await sleep(250);
  return brandCache[word];
}
async function fdaApproved(base) {
  if (!base) return false;
  if (base in fdaCache) return fdaCache[base];
  try {
    const j = await fetchJson(`https://api.fda.gov/drug/drugsfda.json?search=${encodeURIComponent(`products.active_ingredients.name:${base}`)}&limit=1`, `승인 확인 ${base}`, 2);
    fdaCache[base] = (j.results ?? []).length > 0;
  } catch { fdaCache[base] = false; }
  await sleep(250);
  return fdaCache[base];
}
function krStatusOf(bases) {
  if (!Object.keys(krIndex.single).length) return { kr_status: "unknown", kr_first: "" };
  const combo = krIndex.combo[[...new Set(bases)].sort().join("+")];
  if (combo) return { kr_status: "same", kr_first: combo };
  if (bases.length && bases.every(b => krIndex.single[b])) return { kr_status: "parts", kr_first: "" };
  return { kr_status: "none", kr_first: "" };
}

// ---------- 유럽 EMA ----------
async function collectEu() {
  log(`\n==== 유럽 EMA: ${since} ~ ${until} 승인·긍정 의견 찾기 ====`);
  const res = await fetch("https://www.ema.europa.eu/en/media/67423");
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`EMA 응답이 JSON이 아니에요 (${res.status}): ${text.slice(0, 120)}`); }
  const rows = Array.isArray(j) ? j : (Object.values(j).find(v => Array.isArray(v)) ?? []);
  log(`EMA 의약품 ${rows.length}건을 받았어요.`);
  if (rows[0]) log("EMA 항목 이름: " + Object.keys(rows[0]).join(", "));
  const pick = (r, re) => { const k = Object.keys(r).find(k => re.test(k)); return k ? r[k] : ""; };
  const out = [];
  for (const r of rows) {
    if (!/human/i.test(String(r.category ?? "human"))) continue;
    if (Object.entries(r).some(([k, v]) => /generic/i.test(k) && /yes/i.test(String(v)))) continue;
    // 최근 결정일(변경 허가 포함)이 아니라 최초 승인일로 판단해요
    const ec = parseDate(r.marketing_authorisation_date ?? pick(r, /marketing_authori[sz]ation_date|initial.*authori|authorisation_date/) ?? "") ||
      parseDate(r.first_published_date ?? "");
    const op = parseDate(r.opinion_adopted_date ?? pick(r, /opinion.*date/));
    const status = String(r.medicine_status ?? "");
    const opinion = String(r.opinion_status ?? "");
    const isApproved = ec && ec >= since && /authoris/i.test(status);
    const isOpinion = !ec && op && op >= since && /positive/i.test(opinion);
    if (!isApproved && !isOpinion) continue;
    const ind = stripXml(r.therapeutic_indication ?? "");
    const cats = classifyUs(ind);
    if (!cats.length) continue;
    const inn = String(r.international_non_proprietary_name_common_name ?? r.active_substance ?? "");
    out.push({
      name: String(r.name_of_medicine ?? ""), inn, holder: String(r.marketing_authorisation_developer_applicant_holder ?? ""),
      stage: isApproved ? "approved" : "opinion", date: isApproved ? ec : op,
      indication: ind.slice(0, 1500), categories: cats, url: String(r.medicine_url ?? ""),
      biosimilar: Object.entries(r).some(([k, v]) => /biosimilar/i.test(k) && /yes/i.test(String(v)))
    });
  }
  log(`분야에 해당하는 승인·긍정 의견 ${out.length}건. 미국 승인 여부를 확인해요.`);
  for (const e of out) {
    const bs = e.inn.split(/\s*(?:\/|,| and )\s*/i).map(baseName).filter(Boolean);
    let usAny = false;
    if (/vaccin/i.test(e.name + " " + e.inn)) { e.us_approved = null; Object.assign(e, krStatusOf(bs)); continue; }
    for (const b of bs) { if (await fdaApproved(b)) { usAny = true; break; } }
    e.us_approved = usAny;
    Object.assign(e, krStatusOf(bs));
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

// ---------- 국내 임상 3상 (식약처 임상시험 계획) ----------
async function collectKrTrials(key) {
  log(`\n==== 국내 임상 3상 (식약처) ====`);
  const base = "https://apis.data.go.kr/1471000/ClncExamPlanDtlService03";
  const from = new Date(today.getTime() - 730 * 86400000).toISOString().slice(0, 10);
  let op = "", rows = [], total = 0, firstItem = null;
  for (const cand of ["getClncExamPlanDtlInq03", "getClncExamPlanDtlInq02", "getClncExamPlanDtlInq"]) {
    for (const withDate of [true, false]) {
      const p = { serviceKey: key, type: "json", pageNo: "1", numOfRows: "100" };
      if (withDate) Object.assign(p, { clst_aprv_start_dt: `${from} 00:00:00`, clst_aprv_end_dt: `${until.slice(0,4)}-${until.slice(4,6)}-${until.slice(6,8)} 23:59:59` });
      try {
        const res = await fetch(`${base}/${cand}?${new URLSearchParams(p)}`);
        const text = await res.text();
        let j = null; try { j = JSON.parse(text); } catch {}
        const { body, items } = j ? pickItems(j) : { body: null, items: [] };
        if (items.length) {
          op = cand; rows = items; total = Number(body?.totalCount || items.length); firstItem = items[0];
          const pages = Math.min(Math.ceil(total / 100), 40);
          for (let pg = 2; pg <= pages; pg++) {
            const jj = await fetchJson(`${base}/${cand}?${new URLSearchParams({ ...p, pageNo: String(pg) })}`, `국내 임상 ${pg}페이지`, 3);
            rows.push(...pickItems(jj).items);
          }
          log(`작동: ${cand} (날짜 조건 ${withDate ? "사용" : "없이"}), 전체 ${total}건 중 ${rows.length}건 읽음`);
          break;
        } else if (!j) {
          log(`  ${cand}: ${res.status} ${text.slice(0, 100).replace(/\s+/g, " ")}`);
        }
      } catch (e) { log(`  ${cand}: ${e.message}`); }
    }
    if (op) break;
  }
  if (!op) { log("국내 임상 정보를 받지 못했어요. 공공데이터포털에서 '의약품 임상시험 계획 상세정보' 활용신청을 확인해 주세요."); return []; }
  log("항목 이름: " + Object.keys(firstItem).join(", "));

  const groups = {};
  let p3 = 0;
  for (const r of rows) {
    const step = String(r.CLINIC_STEP_NM ?? "");
    if (!/3\s*상|phase\s*(3|iii)/i.test(step)) continue;
    p3++;
    const dt = parseDate(r.CLST_APRV_DT ?? "");
    if (dt && dt < from.replace(/-/g, "")) continue;
    // 분야는 대상 질환과 시험 제목으로만 판단해요 (평가변수에 나오는 부작용 단어에 걸리지 않게)
    const text = [r.TRGT_DISS_NM, r.TRGT_DISS_DTL_CD_NM, r.TRGT_DISS_DTL_ETC, r.CLNC_TEST_TITLE, r.CLNC_TEST_ENG_TITLE].filter(Boolean).join(" ");
    const cats = [...new Set([...classifyKr("", text), ...classifyUs(text)])];
    if (!cats.length) continue;
    const drug = String(r.PRDT_NM || r.GNRL_CD_NM || "").trim();
    if (!drug) continue;
    const code = (drug.match(/[A-Za-z]{1,6}-?\d{3,}/) ?? [])[0];
    const k = (code ?? drug).toLowerCase().replace(/-/g, "");
    const g = (groups[k] ??= { name: drug, ingr: String(r.GNRL_CD_NM ?? ""), sponsors: new Set(), categories: new Set(), trials: [] });
    if (drug.length > g.name.length) g.name = drug;
    g.sponsors.add(String(r.ORGN_DEV_BSSH_NM ?? ""));
    cats.forEach(c => g.categories.add(c));
    g.trials.push({
      title: String(r.CLNC_TEST_TITLE || r.CLNC_TEST_ENG_TITLE || "").slice(0, 300),
      disease: String(r.TRGT_DISS_NM || r.TRGT_DISS_DTL_ETC || ""),
      date: dt, end: parseDate(r.TEST_COMPLETION_DT || r.CLST_END_DT || ""), status: String(r.STATUS ?? ""),
      sn: String(r.CLNC_TEST_SN ?? "")
    });
  }
  log(`3상으로 보이는 시험 ${p3}건, 그중 분야 해당 약 ${Object.keys(groups).length}개`);
  return Object.values(groups).map(g => ({
    name: g.name, ingr: g.ingr, sponsors: [...g.sponsors].filter(Boolean), categories: [...g.categories],
    trials: g.trials.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5), trial_count: g.trials.length,
    latest: g.trials.map(t => t.date).sort().pop() ?? ""
  })).sort((a, b) => b.latest.localeCompare(a.latest));
}

// ---------- 뉴스 (네이버 API HUB 검색, 선택) ----------
// 미용 트렌드 보드에서 쓰는 네이버 API HUB 키를 그대로 써요.
// naver.txt 첫 줄에 Client ID, 둘째 줄에 Client Secret을 넣으면 "심사 중", "출시"를 보도 기준으로 찾아요
const NAVER_BASE = "https://naverapihub.apigw.ntruss.com";
const NAVER_PATHS = ["/search/v1/{kind}", "/search/v1/{kind}.json", "/search/{kind}", "/v1/search/{kind}.json"];
let naverPath = null;
async function naverNews(idSecret, q) {
  const headers = { "X-NCP-APIGW-API-KEY-ID": idSecret[0], "X-NCP-APIGW-API-KEY": idSecret[1] };
  const tries = naverPath ? [naverPath] : NAVER_PATHS;
  let last = "";
  for (const tpl of tries) {
    const url = `${NAVER_BASE}${tpl.replace("{kind}", "news")}?${new URLSearchParams({ query: q, display: "30", sort: "date" })}`;
    const res = await fetch(url, { headers });
    if (res.ok) {
      naverPath = tpl;
      const j = await res.json();
      await sleep(150);
      return (j.items ?? []).map(it => ({
        title: stripXml(it.title).replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'"),
        link: it.originallink || it.link,
        date: ymd(new Date(it.pubDate))
      }));
    }
    last = `${res.status} ${(await res.text()).slice(0, 120)}`;
    if (res.status === 401 || res.status === 403) break;
  }
  throw new Error(`네이버 뉴스 검색 실패: ${last}`);
}
function krToken(name) {
  return String(name).replace(/\(.*$/, "").replace(/[\d.]+\s*(밀리그램|마이크로그램|그램|밀리리터|mg|%).*$/i, "")
    .replace(/(오토인젝터주|프리필드시린지주|프리필드펜주|주사액|점안액|점안제|주|정|캡슐|액|산|겔|크림|연고|패치)$/, "").trim();
}
async function addNews(idSecret, krNew, usHit, trials) {
  log(`\n==== 뉴스 (보도 기준 심사·출시) ====`);
  let n = 0;
  for (const x of krNew) {
    const tok = krToken(x.name);
    if (tok.length < 2) continue;
    try {
      const items = await naverNews(idSecret, `${tok} 출시`);
      const hit = items.find(a => a.date >= x.permit_date && a.title.includes(tok) && /출시|발매|런칭|선보/.test(a.title));
      if (hit) { x.news_kr_launch = hit; n++; }
    } catch (e) { if (/ 40[13] /.test(e.message)) throw new Error("네이버 키를 확인해 주세요 (" + e.message + ")"); log(`  ${tok}: ${e.message}`); }
  }
  for (const x of usHit.filter(u => u.kr_status !== "same")) {
    const brand = String(x.brand).toLowerCase();
    const inn = baseName(x.ingredients);
    try {
      const items = [...await naverNews(idSecret, `${x.brand} 허가 신청`), ...await naverNews(idSecret, `${inn} 식약처`)];
      const hit = items.find(a => a.date >= x.approval_date && (a.title.toLowerCase().includes(brand) || a.title.toLowerCase().includes(inn)) && /허가\s*신청|허가를\s*신청|품목허가|식약처\s*심사|허가\s*심사/.test(a.title));
      if (hit) { x.news_kr_review = hit; n++; }
    } catch (e) { if (/ 40[13] /.test(e.message)) throw new Error("네이버 키를 확인해 주세요 (" + e.message + ")"); log(`  ${x.brand}: ${e.message}`); }
  }
  for (const t of trials.filter(t => t.stage === "phase3_done")) {
    const tok = String(t.name).toLowerCase();
    try {
      const items = await naverNews(idSecret, `${t.name} FDA`);
      const hit = items.find(a => a.title.toLowerCase().includes(tok) && /FDA/i.test(a.title) && /신청|접수|심사|제출/.test(a.title) && !/승인/.test(a.title));
      if (hit) { t.news_us_review = hit; n++; }
    } catch (e) { if (/ 40[13] /.test(e.message)) throw new Error("네이버 키를 확인해 주세요 (" + e.message + ")"); log(`  ${t.name}: ${e.message}`); }
  }
  log(`보도로 확인한 단계 ${n}건`);
}

// ---------- 실행 ----------
async function main() {
  await mkdir(dataDir, { recursive: true });
  // 키는 GitHub에서 돌 때는 Secrets(환경변수)에서, 내 컴퓨터에서는 key.txt·naver.txt에서 읽어요
  let key = (process.env.DATA_KEY ?? "").trim();
  if (!key) { try { key = (await readFile(path.join(here, "key.txt"), "utf8")).trim(); } catch { /* 아래에서 안내 */ } }
  let naver = process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET
    ? [process.env.NAVER_CLIENT_ID.trim(), process.env.NAVER_CLIENT_SECRET.trim()] : null;
  if (!naver) {
    try {
      const lines = (await readFile(path.join(here, "naver.txt"), "utf8")).split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      if (lines.length >= 2 && !lines.some(l => l.includes("붙여넣"))) naver = lines.slice(0, 2);
    } catch { /* 없으면 뉴스는 건너뜀 */ }
  }

  const step = async (label, fn, fallback) => { try { return await fn(); } catch (e) { log(`${label} 중단: ${e.message}`); return fallback; } };

  const kr = key ? await step("식약처 수집", () => collectKr(key), []) : (log("key.txt가 없어서 식약처는 건너뛰어요."), []);
  const us = await step("FDA 수집", () => collectUs(), []);
  const approvedBases = new Set(us.flatMap(x => String(x.ingredients).split(" + ").map(baseName)));
  const trials = await step("임상 수집", () => collectTrials(approvedBases), []);
  const krTrials = key ? await step("국내 임상 수집", () => collectKrTrials(key), []) : [];
  const eu = await step("EMA 수집", () => collectEu(), []);

  const krSplit = splitKr(kr);
  const usHit = us.filter(x => x.categories.length);
  const euFirst = eu.filter(e => !e.us_approved);

  if (naver) await step("뉴스 확인", () => addNews(naver, krSplit.newOnes, usHit, trials), null);
  else log("\nnaver.txt가 없어서 뉴스(보도 기준 심사·출시)는 건너뛰어요.");

  await writeFile(path.join(dataDir, "kr-all.json"), JSON.stringify(kr, null, 2), "utf8");
  await writeFile(path.join(dataDir, "us-all.json"), JSON.stringify(us, null, 2), "utf8");
  await writeFile(path.join(dataDir, "eu-all.json"), JSON.stringify(eu, null, 2), "utf8");
  const collected = {
    generated_at: new Date().toISOString(), since, until,
    kr: { new: krSplit.newOnes, first_generic: krSplit.firstGenerics, generic_trend: krSplit.trend, trials: krTrials },
    us: usHit,
    us_trials: trials,
    eu: euFirst,
    categories: CATEGORIES,
    news: !!naver
  };
  await writeFile(path.join(dataDir, "collected.json"), JSON.stringify(collected, null, 2), "utf8");
  await writeFile(path.join(dataDir, "radar-data.js"), "window.RADAR_DATA = " + JSON.stringify(collected) + ";\n", "utf8");

  const krText = x => ({
    same: `국내에 같은 성분 허가 있음 (첫 허가 ${x.kr_first})`,
    parts: "국내에 각 성분은 있지만 이 조합은 없음",
    none: "국내 허가 없음",
    unknown: "국내 확인 못 함"
  })[x.kr_status] ?? "";
  const nw = a => a ? ` / 보도: ${a.title} (${a.date})` : "";

  log("\n================ 요약 ================");
  log(`기간: ${since} ~ ${until}`);
  log(`\n[국내 허가] 기간 내 ${kr.length}건 중 분야 해당 ${kr.filter(x => x.categories.length).length}건 (한약 제제 ${krSplit.herbalCount}건 제외)`);
  log(`· 신약·새 적응증·첫 등장 ${krSplit.newOnes.length}건`);
  krSplit.newOnes.forEach(x => {
    log(`  ${x.permit_date} [${x.categories.join(",")}] ${x.name} / ${x.company} / ${x.newdrug || (x.new_indication ? "새 적응증" : "첫 등장")}${nw(x.news_kr_launch)}`);
    if (x.followers.length) log(`      뒤따라 허가: ${x.followers.join(", ")}`);
  });
  log(`· 첫 제네릭 ${krSplit.firstGenerics.length}건`);
  krSplit.firstGenerics.forEach(x => log(`  ${x.first_date} [${x.categories.join(",")}] ${x.ingredient} / 오리지널 ${x.originator} / 들어온 회사 ${x.entrants.map(e => e.company).join(", ")}`));
  log(`· 복제약 흐름 (2개 회사 이상)`);
  krSplit.trend.filter(t => t.companies >= 2).forEach(t => log(`  [${t.categories.join(",")}] ${t.ingredient}: ${t.companies}개 회사`));

  log(`\n[국내 임상 3상] 분야 해당 약 ${krTrials.length}개`);
  krTrials.slice(0, 30).forEach(t => log(`  ${t.latest} [${t.categories.join(",")}] ${t.name} / ${t.sponsors.join(", ")} / 시험 ${t.trial_count}건 / ${t.trials[0]?.disease || ""} / ${(t.trials[0]?.title ?? "").slice(0, 50)}`));

  log(`\n[미국 FDA 승인] ${us.length}건 중 분야 해당 ${usHit.length}건`);
  usHit.forEach(x => log(`  ${x.approval_date} [${x.categories.join(",")}] ${x.brand} (${x.ingredients}) / ${krText(x)}${nw(x.news_kr_review)}`));

  log(`\n[미국 임상 3상] 승인 전 약 ${trials.length}개`);
  trials.forEach(t => log(`  [${t.categories.join(",")}] ${t.name} / ${t.sponsors.join(", ")} / ${t.stage === "phase3_active" ? "3상 진행 중" : "3상 완료 " + t.last_done} / 시험 ${t.trial_count}건 / ${krText(t)}${nw(t.news_us_review)}`));

  log(`\n[유럽 EMA] 분야 해당 ${eu.length}건, 그중 미국 승인 없는 약 ${euFirst.length}건`);
  eu.forEach(e => log(`  ${e.date} [${e.categories.join(",")}] ${e.name} (${e.inn}) / ${e.stage === "approved" ? "EU 승인" : "CHMP 긍정 의견"} / 미국 ${e.us_approved === null ? "확인 못 함(백신)" : e.us_approved ? "승인 있음" : "승인 없음"} / ${krText(e)}`));

  log("\n결과는 data 폴더에 저장했어요. 위 요약을 전부 복사해서 보내주세요.");
}

main();
