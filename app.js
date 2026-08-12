(() => {
  'use strict';
  const piano = document.querySelector('#piano');
  const labels = document.querySelector('#labels');
  const velocity = document.querySelector('#velocity');
  const velOut = document.querySelector('#velOut');
  const sustainBtn = document.querySelector('#sustain');
  const fullscreenBtn = document.querySelector('#fullscreen');
  const toneSelect = document.querySelector('#tone');
  const status = document.querySelector('#status');
  const about = document.querySelector('#about');

  const START = 60; // C4
  const END = 88;   // E6
  const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const WHITE_PC = new Set([0,2,4,5,7,9,11]);
  const BASE = 'https://raw.githubusercontent.com/sfzinstruments/SalamanderGrandPiano/master/Samples/';
  const buffers = new Map();
  const active = new Map();
  const pendingReleases = new Set();
  const pointers = new Map();
  let audio = null;
  let master = null;
  let toneFilter = null;
  let toneShelf = null;
  let sustain = false;

  const TONES = {
    concert: {name:'Concert', cutoff:18000, shelf:0, volume:.86},
    warm:    {name:'Warm', cutoff:7000, shelf:-2.5, volume:.9},
    bright:  {name:'Bright', cutoff:20000, shelf:4.5, volume:.8},
    mellow:  {name:'Mellow', cutoff:3800, shelf:-4.5, volume:.95}
  };

  function noteName(midi){
    const pc = midi % 12;
    const oct = Math.floor(midi / 12) - 1;
    return `${NOTE_NAMES[pc]}${oct}`;
  }

  function regionFor(midi){
    const centers = [21];
    for(let c=24;c<=108;c+=3) centers.push(c);
    let best = centers[0], dist = Infinity;
    for(const c of centers){
      const d = Math.abs(midi-c);
      if(d < dist){best=c;dist=d;}
    }
    return best;
  }

  function layerFor(v){
    if(v < 45) return 3;
    if(v < 73) return 7;
    if(v < 105) return 11;
    return 15;
  }

  function sampleURL(center, layer){
    const file = `${noteName(center)}v${layer}.flac`;
    return BASE + encodeURIComponent(file).replace(/%2F/g,'/');
  }

  function applyTone(){
    const preset = TONES[toneSelect?.value || 'concert'] || TONES.concert;
    if(toneFilter){
      toneFilter.frequency.setTargetAtTime(preset.cutoff, audio.currentTime, .025);
      toneShelf.gain.setTargetAtTime(preset.shelf, audio.currentTime, .025);
      master.gain.setTargetAtTime(preset.volume, audio.currentTime, .025);
    }
    status.textContent = `${preset.name} · Salamander Grand`;
  }

  async function ensureAudio(){
    if(!audio){
      audio = new (window.AudioContext || window.webkitAudioContext)({latencyHint:'interactive'});
      master = audio.createGain();
      toneFilter = audio.createBiquadFilter();
      toneShelf = audio.createBiquadFilter();
      toneFilter.type = 'lowpass';
      toneFilter.Q.value = .45;
      toneShelf.type = 'highshelf';
      toneShelf.frequency.value = 3200;
      toneFilter.connect(toneShelf).connect(master).connect(audio.destination);
      applyTone();
    }
    if(audio.state === 'suspended') await audio.resume();
  }

  async function loadSample(center, layer){
    const key = `${center}:${layer}`;
    if(buffers.has(key)) return buffers.get(key);
    const p = (async()=>{
      status.textContent = `Loading ${noteName(center)}…`;
      const res = await fetch(sampleURL(center, layer), {cache:'force-cache'});
      if(!res.ok) throw new Error(`Sample ${res.status}`);
      const arr = await res.arrayBuffer();
      const decoded = await audio.decodeAudioData(arr.slice(0));
      applyTone();
      return decoded;
    })().catch(err=>{buffers.delete(key); throw err;});
    buffers.set(key,p);
    return p;
  }

  function synthFallback(midi, v){
    const now = audio.currentTime;
    const freq = 440 * Math.pow(2,(midi-69)/12);
    const gain = audio.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(.015, (v/127)*.18), now+.008);
    gain.gain.exponentialRampToValueAtTime(.0001, now+1.8);
    gain.connect(toneFilter);
    const o1=audio.createOscillator(), o2=audio.createOscillator();
    o1.type='triangle'; o2.type='sine'; o1.frequency.value=freq; o2.frequency.value=freq*2.002;
    const g2=audio.createGain(); g2.gain.value=.2; o2.connect(g2).connect(gain); o1.connect(gain);
    o1.start(now);o2.start(now);o1.stop(now+1.9);o2.stop(now+1.9);
    return {sources:[o1,o2],gain,fallback:true};
  }

  async function noteOn(midi, vel=Number(velocity.value)){
    await ensureAudio();
    if(active.has(midi)) noteOff(midi,true);
    const el = piano.querySelector(`[data-midi="${midi}"]`);
    el?.classList.add('active');
    const center = regionFor(midi), layer=layerFor(vel);
    try{
      const buffer = await loadSample(center,layer);
      const src = audio.createBufferSource();
      const gain = audio.createGain();
      src.buffer=buffer;
      src.playbackRate.value=Math.pow(2,(midi-center)/12);
      gain.gain.value=0.42 + (vel/127)*0.58;
      src.connect(gain).connect(toneFilter);
      src.start();
      active.set(midi,{sources:[src],gain,fallback:false});
    }catch(e){
      console.warn('Using fallback synth:',e);
      status.textContent='Sample unavailable · fallback sound';
      active.set(midi,synthFallback(midi,vel));
    }
  }

  function releaseVoice(midi, immediate=false){
    const voice=active.get(midi); if(!voice) return;
    const now=audio?.currentTime || 0;
    try{
      if(!voice.fallback && voice.gain){
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(Math.max(.0001,voice.gain.gain.value),now);
        voice.gain.gain.exponentialRampToValueAtTime(.0001,now+(immediate?.04:.55));
        voice.sources.forEach(s=>s.stop(now+(immediate?.06:.62)));
      }
    }catch{}
    active.delete(midi);
    piano.querySelector(`[data-midi="${midi}"]`)?.classList.remove('active');
  }

  function noteOff(midi, immediate=false){
    piano.querySelector(`[data-midi="${midi}"]`)?.classList.remove('active');
    if(sustain && !immediate){ pendingReleases.add(midi); return; }
    pendingReleases.delete(midi); releaseVoice(midi, immediate);
  }

  function setSustain(on){
    sustain=on; sustainBtn.setAttribute('aria-pressed',String(on));
    if(!on){ for(const midi of [...pendingReleases]) releaseVoice(midi); pendingReleases.clear(); }
  }

  function buildKeyboard(){
    piano.innerHTML='';
    const whites=[];
    for(let m=START;m<=END;m++) if(WHITE_PC.has(m%12)) whites.push(m);
    const whiteW=100/whites.length;
    const whiteIndex=new Map();
    whites.forEach((m,i)=>whiteIndex.set(m,i));
    for(let m=START;m<=END;m++){
      const pc=m%12, isWhite=WHITE_PC.has(pc);
      const key=document.createElement('div');
      key.className=`key ${isWhite?'white':'black'}`;
      key.dataset.midi=m;
      key.setAttribute('role','button'); key.setAttribute('aria-label',noteName(m));
      if(isWhite){
        const i=whiteIndex.get(m); key.style.left=`${i*whiteW}%`; key.style.width=`${whiteW}%`;
      } else {
        let prev=m-1; while(prev>=START && !WHITE_PC.has(prev%12)) prev--;
        const i=whiteIndex.get(prev);
        const bw=whiteW*.62;
        key.style.width=`${bw}%`;
        key.style.left=`${(i+1)*whiteW-bw/2}%`;
      }
      const lab=document.createElement('span');lab.className='label';lab.textContent=noteName(m);key.appendChild(lab);
      piano.appendChild(key);
    }
  }

  function midiFromPoint(x,y){
    const els=document.elementsFromPoint(x,y);
    const key=els.find(e=>e.classList?.contains('key'));
    return key ? Number(key.dataset.midi) : null;
  }

  piano.addEventListener('pointerdown', async e=>{
    e.preventDefault(); piano.setPointerCapture?.(e.pointerId);
    const midi=midiFromPoint(e.clientX,e.clientY); if(midi==null)return;
    pointers.set(e.pointerId,midi); await noteOn(midi);
  });
  piano.addEventListener('pointermove', async e=>{
    if(!pointers.has(e.pointerId)) return;
    const old=pointers.get(e.pointerId), midi=midiFromPoint(e.clientX,e.clientY);
    if(midi!=null && midi!==old){noteOff(old);pointers.set(e.pointerId,midi);await noteOn(midi);}
  });
  function pointerEnd(e){const m=pointers.get(e.pointerId);if(m!=null)noteOff(m);pointers.delete(e.pointerId);}
  piano.addEventListener('pointerup',pointerEnd);piano.addEventListener('pointercancel',pointerEnd);

  const keyMap={a:60,w:61,s:62,e:63,d:64,f:65,t:66,g:67,y:68,h:69,u:70,j:71,k:72};
  const down=new Set();
  window.addEventListener('keydown',e=>{const k=e.key.toLowerCase();if(k===' '){e.preventDefault();setSustain(true);return;}if(keyMap[k]&&!down.has(k)){down.add(k);noteOn(keyMap[k]);}});
  window.addEventListener('keyup',e=>{const k=e.key.toLowerCase();if(k===' '){setSustain(false);return;}if(keyMap[k]){down.delete(k);noteOff(keyMap[k]);}});

  labels.addEventListener('change',()=>piano.classList.toggle('show-labels',labels.checked));
  velocity.addEventListener('input',()=>velOut.value=velocity.value);
  toneSelect.addEventListener('change',()=>{ if(audio) applyTone(); else status.textContent=`${TONES[toneSelect.value].name} selected`; });
  sustainBtn.addEventListener('click',()=>setSustain(!sustain));
  fullscreenBtn.addEventListener('click',async()=>{
    try{if(!document.fullscreenElement) await document.documentElement.requestFullscreen(); else await document.exitFullscreen();}
    catch{status.textContent='Tip: Add to Home Screen for full screen';}
  });
  document.querySelector('#info').addEventListener('click',()=>about.showModal());
  document.querySelector('#closeAbout').addEventListener('click',()=>about.close());

  buildKeyboard();
  if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
})();
