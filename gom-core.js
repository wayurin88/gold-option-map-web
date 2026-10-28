/* Gold Option Map: สูตรทั้งหมด ใช้ร่วมกันระหว่างหน้าเว็บ (window.GOM) และ scripts/build_feed.js (Node)
   แก้สูตรที่นี่แล้วแก้ docs/method.md ด้วย */
(function(root){
'use strict';

function fmt(v,d){if(v===null||v===undefined||!isFinite(v))return '—';return Number(v).toLocaleString('en-US',{minimumFractionDigits:d===undefined?2:d,maximumFractionDigits:d===undefined?2:d})}

/* ---------- อ่านไฟล์ ---------- */
/* แถว strike, Call OI, Put OI [, Call OI วันก่อน, Put OI วันก่อน] คั่นด้วย comma หรือ tab */
function parseOI(txt){
  var out=[];
  txt.split(/\r?\n/).forEach(function(line){
    line=line.trim(); if(!line||line.charAt(0)==='#') return;
    var parts=line.indexOf('\t')>=0?line.split('\t').map(function(s){return s.replace(/,/g,'')}):line.split(/[;,]/);
    var n=parts.map(function(s){return parseFloat(String(s).replace(/["'\s]/g,''))});
    if(n.length<3||n.slice(0,3).some(isNaN)) return;
    var r={k:n[0],c:Math.max(0,n[1]),p:Math.max(0,n[2])};
    if(isFinite(n[3])&&isFinite(n[4])){r.pc=Math.max(0,n[3]);r.pp=Math.max(0,n[4])}
    out.push(r);
  });
  out.sort(function(a,b){return a.k-b.k});
  return out;
}
/* บรรทัด "# key=value" ด้านบนไฟล์ของ qs_to_map.py */
function parseMeta(txt){
  var meta={};
  txt.split(/\r?\n/).forEach(function(l){var m=/^\s*#\s*([a-z_]+)\s*=\s*(.*)$/i.exec(l);if(m)meta[m[1].toLowerCase()]=m[2].trim()});
  return meta;
}

/* ---------- Expected Move ---------- */
/* โหมด straddle: σ รายวันมาจากการ์ด Telegram ของ qs-archive รายสัปดาห์ = σ × √5 ส่วนถึงหมดอายุยังใช้ IV */
function emOf(inp){
  var Fb=inp.F-inp.basis, iv=inp.iv/100;
  var em=function(days){return Fb*iv*Math.sqrt(days/252)};
  var useSd=inp.em==='straddle'&&inp.sd>0;
  var sig=useSd?inp.sd:em(1), tdays=Math.max(1,Math.round(inp.dte*5/7));
  return {Fb:Fb,sig:sig,tdays:tdays,EM:{day:sig,week:useSd?sig*Math.sqrt(5):em(5),exp:em(tdays),src:useSd?'straddle':'iv'}};
}

/* ---------- จาก OI: Put/Call, Max Pain, Wall (ราคาเป็นหน่วยฟิวเจอร์ส) ---------- */
function oiStats(rows,F,sig,emExp){
  var tc=0,tp=0,hasPrev=rows.length>0&&rows.every(function(r){return r.pc!==undefined});
  rows.forEach(function(r){tc+=r.c;tp+=r.p});
  var mp=null,best=Infinity;
  rows.forEach(function(s){
    var pay=0; rows.forEach(function(r){pay+=r.c*Math.max(s.k-r.k,0)+r.p*Math.max(r.k-s.k,0)});
    if(pay<best){best=pay;mp=s.k}
  });
  /* strike ติดกัน (เช่น 4500 กับ 4510) นับเป็น Wall เดียว: ข้าม strike ที่ห่างจาก Wall ที่เลือกแล้วไม่ถึง 0.5 SD รายวัน
     d = OI เปลี่ยนจากวันก่อน (มีเมื่อไฟล์มีคอลัมน์วันก่อน) */
  function walls(key,pkey,filter){
    var out=[];
    rows.filter(filter).filter(function(r){return r[key]>0}).sort(function(a,b){return b[key]-a[key]}).forEach(function(r){
      if(out.length<3&&out.every(function(o){return Math.abs(o.strike-r.k)>0.5*sig}))
        out.push({strike:r.k,oi:r[key],d:hasPrev?r[key]-r[pkey]:null,rank:out.length+1});
    });
    return out;
  }
  /* Wall นับเฉพาะ strike ในกรอบ ±2 SD ถึงวันหมดอายุ ตัด strike ไกลมากที่ OI สูงแต่ไม่มีผลกับราคา (เช่น Call 20000) */
  var near=function(r){return Math.abs(r.k-F)<=2*emExp};
  return {mp:mp,pcr:tc>0?tp/tc:null,tc:tc,tp:tp,hasPrev:hasPrev,
    callWalls:walls('c','pc',function(r){return r.k>=F&&near(r)}),putWalls:walls('p','pp',function(r){return r.k<=F&&near(r)})};
}

/* ---------- แผน ---------- */
/* inp: F, basis, iv, dte, date, px, em, sd และ rows (ตาราง OI) หรือ stats (ผลจาก oiStats ที่คำนวณไว้แล้ว) */
function compute(inp){
  var F=inp.F, basis=inp.basis, iv=inp.iv/100;
  var x=function(v){return v-basis};
  var e=emOf(inp), Fb=e.Fb, sig=e.sig, EM=e.EM, px=isFinite(inp.px)?inp.px:Fb;
  var st=inp.stats||oiStats(inp.rows,F,sig,EM.exp), mp=st.mp, pcr=st.pcr;
  var bands={sd1:[Fb-sig,Fb+sig],sd2:[Fb-2*sig,Fb+2*sig],sd3:[Fb-3*sig,Fb+3*sig],week:[Fb-EM.week,Fb+EM.week]};
  var wv=function(w){return {strike:w.strike,v:x(w.strike),oi:w.oi,d:w.d,rank:w.rank}};
  var callWalls=st.callWalls.map(wv), putWalls=st.putWalls.map(wv);

  /* มุมมอง */
  var score=0, why=[];
  if(mp!==null){
    var d=x(mp)-px;
    if(Math.abs(d)>0.5*sig){score+=d>0?1:-1;why.push((d>0?'ราคาอยู่ต่ำกว่า':'ราคาอยู่สูงกว่า')+' Max Pain '+fmt(Math.abs(d),1)+' จุด ใกล้วันหมดอายุราคามักถูกดึงเข้าหา Max Pain')}
    else why.push('ราคาอยู่ใกล้ Max Pain ไม่มีแรงดึงชัดเจน');
  }
  if(pcr!==null){
    if(pcr<0.7){score+=0.5;why.push('Put/Call '+pcr.toFixed(2)+' (Call OI มากกว่า Put ชัดเจน ตลาดเปิดสถานะฝั่งขึ้นมากกว่า)')}
    else if(pcr>1.3){score-=0.5;why.push('Put/Call '+pcr.toFixed(2)+' (Put OI มากกว่า Call ชัดเจน ตลาดป้องกันขาลงมากกว่า)')}
    else why.push('Put/Call '+pcr.toFixed(2)+' อยู่ในช่วงกลาง');
  }
  if(px>bands.sd1[1]) why.push('ราคาอยู่เหนือกรอบ 1SD แล้ว ถ้ายืนได้ให้ถือเป็น Breakout ขึ้น');
  else if(px<bands.sd1[0]) why.push('ราคาอยู่ใต้กรอบ 1SD แล้ว ถ้ายืนได้ให้ถือเป็น Breakdown');
  var bias=score>=1?'up':score<=-1?'down':'flat';

  /* ระดับทั้งหมด (หน่วย XAUUSD) */
  var L=[];
  ['sd1','sd2','sd3'].forEach(function(b,i){L.push({v:bands[b][0],t:'band',n:'ขอบล่าง '+(i+1)+'SD',w:i===0?2:1});L.push({v:bands[b][1],t:'band',n:'ขอบบน '+(i+1)+'SD',w:i===0?2:1})});
  L.push({v:bands.week[0],t:'week',n:'ขอบล่างรายสัปดาห์',w:1},{v:bands.week[1],t:'week',n:'ขอบบนรายสัปดาห์',w:1});
  putWalls.forEach(function(w){L.push({v:w.v,t:'put',n:'Put Wall '+w.rank,w:4-w.rank})});
  callWalls.forEach(function(w){L.push({v:w.v,t:'call',n:'Call Wall '+w.rank,w:4-w.rank})});
  if(mp!==null) L.push({v:x(mp),t:'mp',n:'Max Pain',w:1});
  L.push({v:Fb,t:'mid',n:'Settle',w:1});

  function clusters(list){
    var out=[];
    list.forEach(function(l){
      var c=out[out.length-1];
      if(c&&Math.abs(c.items[0].v-l.v)<=0.15*sig){c.items.push(l)} else out.push({items:[l]});
    });
    out.forEach(function(c){c.items.sort(function(a,b){return (b.t==='put'||b.t==='call')-(a.t==='put'||a.t==='call')||b.w-a.w});c.anchor=c.items[0]});
    return out;
  }
  var gap=0.1*sig;
  /* Max Pain กับ Settle เป็นจุดดึงดูด ใช้เป็นเป้า TP ไม่ใช้เป็นจุดเข้า */
  var sup=clusters(L.filter(function(l){return l.v<px-gap&&l.t!=='call'&&l.t!=='mid'&&l.t!=='mp'}).sort(function(a,b){return b.v-a.v}));
  var res=clusters(L.filter(function(l){return l.v>px+gap&&l.t!=='put'&&l.t!=='mid'&&l.t!=='mp'}).sort(function(a,b){return a.v-b.v}));

  function zone(cl,side,rank){
    var a=cl.anchor.v, w=0.1*sig, buy=side==='buy';
    var from=a, to=buy?a+w:a-w, entry=(from+to)/2, sl=buy?from-0.25*sig:from+0.25*sig, risk=Math.abs(entry-sl);
    var tgt=L.map(function(l){return l.v}).filter(function(v){return buy?v>entry+0.3*sig:v<entry-0.3*sig}).sort(function(p,q){return buy?p-q:q-p});
    var tp=[]; tgt.forEach(function(v){if(tp.length<3&&(!tp.length||Math.abs(v-tp[tp.length-1])>gap))tp.push(v)});
    while(tp.length<3) tp.push(entry+(buy?1:-1)*risk*(tp.length+1)*1.5);
    var r1=Math.abs(tp[0]-entry)/risk;
    var names=cl.items.map(function(l){return l.n});
    var s=0, why=[names.join(' + ')];
    if(cl.items.length>1){s++;why.push('หลายระดับซ้อนกัน')}
    if(cl.anchor.t==='put'||cl.anchor.t==='call') s++;
    if((buy&&bias==='up')||(!buy&&bias==='down')){s++;why.push('ตามมุมมอง')}
    if((buy&&bias==='down')||(!buy&&bias==='up')){s--;why.push('สวนมุมมอง')}
    if(a>=bands.week[0]&&a<=bands.week[1]) why.push('อยู่ในกรอบสัปดาห์'); else {s--;why.push('นอกกรอบสัปดาห์')}
    if(r1<1){s--;why.push('TP1 ต่ำกว่า 1R')}
    return {id:(buy?'Buy ':'Sell ')+rank,side:side,from:Math.min(from,to),to:Math.max(from,to),entry:entry,sl:sl,tp:tp,r:r1,
      conf:s>=2?'high':s>=1?'medium':'low',why:why.join(' · ')};
  }
  var zones=[];
  sup.slice(0,2).forEach(function(c,i){zones.push(zone(c,'buy',i+1))});
  res.slice(0,2).forEach(function(c,i){zones.push(zone(c,'sell',i+1))});

  return {F:F,basis:basis,Fb:Fb,px:px,sig:sig,EM:EM,tdays:e.tdays,bands:bands,pcr:pcr,mp:mp,callWalls:callWalls,putWalls:putWalls,
    bias:bias,why:why,levels:L,zones:zones,rows:inp.rows||[],hasPrev:st.hasPrev,iv:iv,dte:inp.dte,date:inp.date};
}

/* เทียบกับแผนวันก่อน: Wall ที่ไม่อยู่ใน 3 อันดับของวันก่อนนับเป็น Wall ใหม่ */
function compare(m,p){
  if(!p) return;
  var isNew=function(list,w){return !list.some(function(o){return o.strike===w.strike})};
  m.callWalls.forEach(function(w){w.isNew=isNew(p.callWalls,w)});
  m.putWalls.forEach(function(w){w.isNew=isNew(p.putWalls,w)});
  m.prev={date:p.date,mp:p.mp,pcr:p.pcr};
}

/* บรรทัด PLAN ให้อินดิเคเตอร์ gold_option_map_plan.pine ราคาทั้งหมดเป็นหน่วยฟิวเจอร์ส
   ส่ง p (แผนวันก่อน) มาด้วยเพื่อต่อท้ายเป็น " | PREV ..." คัดลอกครั้งเดียวได้ทั้งสองวัน */
function planLine(m,p){
  function one(m,tag){
    var f=function(v){return (v+m.basis).toFixed(2)}, pair=function(a){return f(a[0])+','+f(a[1])};
    var t=[tag,'d='+(m.date||''),'b='+{up:'U',down:'D',flat:'F'}[m.bias],'sd1='+pair(m.bands.sd1),'sd2='+pair(m.bands.sd2),'wk='+pair(m.bands.week)];
    if(m.mp!==null)t.push('mp='+m.mp);
    if(m.callWalls.length)t.push('cw='+m.callWalls.map(function(w){return w.strike}).join(','));
    if(m.putWalls.length)t.push('pw='+m.putWalls.map(function(w){return w.strike}).join(','));
    m.zones.forEach(function(z){t.push((z.side==='buy'?'B':'S')+z.id.slice(-1)+'='+[z.from,z.to,z.entry,z.sl].concat(z.tp).map(f).join(','))});
    return t.join(' ');
  }
  return one(m,'PLAN')+(p?' | '+one(p,'PREV'):'');
}

var GOM={fmt:fmt,parseOI:parseOI,parseMeta:parseMeta,emOf:emOf,oiStats:oiStats,compute:compute,compare:compare,planLine:planLine};
root.GOM=GOM;
if(typeof module!=='undefined'&&module.exports) module.exports=GOM;
})(typeof window!=='undefined'?window:globalThis);
