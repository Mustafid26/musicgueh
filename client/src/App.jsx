import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Play, Pause, SkipForward, SkipBack, Search, Volume2, 
  VolumeX, Music, Disc3, Radio, Heart, ListMusic, ShieldCheck, 
  Sparkles, Flame, Loader2, Zap, Shuffle, Repeat, Repeat1,
  Menu, X
} from 'lucide-react';

const API_BASE = import.meta.env.API_BASE_URL || 'http://localhost:8000/api';

/**
 * Spotify Multi-Attribute Balanced Shuffle (Fiedler Dithering + Genre/Vibe Clustering Prevention)
 *
 * Implements Spotify's hierarchical shuffle model:
 * 1. Multi-dimensional Feature Extraction (Artist, Genre, Mood/Vibe, Tempo/Duration profile)
 * 2. Multi-cluster Dithering Spread across the playlist timeline [0.0 - 1.0]
 * 3. Freshness / Consecutive Penalty Scoring to ensure seamless transitions
 */

// Heuristic keyword classifier for genre & vibe detection from title/uploader metadata
function extractTrackAttributes(track) {
  const text = `${track.title || ''} ${track.uploader || ''}`.toLowerCase();

  // Genre detection
  let genre = 'pop';
  if (/dangdut|koplo|kendang|campursari/.test(text)) genre = 'dangdut';
  else if (/rock|metal|punk|band|grunge/.test(text)) genre = 'rock';
  else if (/hiphop|hip-hop|rap|r&b|trap/.test(text)) genre = 'hiphop';
  else if (/edm|remix|dj|bass|electronic|dance|house/.test(text)) genre = 'electronic';
  else if (/lofi|lo-fi|chill|acoustic|akustik|piano|instrumental/.test(text)) genre = 'chill';
  else if (/indie|folk|alternative/.test(text)) genre = 'indie';
  else if (/jazz|blues|soul/.test(text)) genre = 'jazz';

  // Vibe / Energy / Mood detection
  let vibe = 'upbeat';
  if (/galau|sedih|sad|slow|ballad|acoustic|healing|sleep|night|hujan/.test(text)) {
    vibe = 'mellow';
  } else if (/joget|party|remix|hype|festival|koplo|bengis|bassboosted/.test(text)) {
    vibe = 'high-energy';
  } else if (/chill|vibe|relax|santai|sore|coffee|cozy/.test(text)) {
    vibe = 'chill';
  }

  // Duration profile: short (<3m), medium (3-5m), long (>5m)
  const dur = track.duration || 210;
  let tempoProfile = 'medium';
  if (dur < 180) tempoProfile = 'fast';
  else if (dur > 300) tempoProfile = 'extended';

  return {
    artist: (track.uploader || 'unknown').trim().toLowerCase(),
    genre,
    vibe,
    tempoProfile
  };
}

function spotifyBalancedShuffle(songs) {
  if (!songs || songs.length <= 1) return [...(songs || [])];

  const enriched = songs.map(song => ({
    song,
    attr: extractTrackAttributes(song)
  }));

  // 1. Group by Composite Fingerprint: Genre + Vibe (Multi-Attribute Clustering)
  const clusterMap = new Map();
  for (const item of enriched) {
    const key = `${item.attr.genre}__${item.attr.vibe}`;
    if (!clusterMap.has(key)) {
      clusterMap.set(key, []);
    }
    clusterMap.get(key).push(item);
  }

  // 2. Intra-cluster Fisher-Yates with artist-separation check
  for (const group of clusterMap.values()) {
    for (let i = group.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [group[i], group[j]] = [group[j], group[i]];
    }
  }

  // 3. Multi-point Dithering Spread across [0, 1] range
  const placed = [];
  for (const group of clusterMap.values()) {
    const k = group.length;
    const spacing = 1 / k;
    let cursor = Math.random() * spacing;

    for (const item of group) {
      // Jitter adds non-periodic organic feel without clustering
      const jitter = (Math.random() - 0.5) * spacing * 0.45;
      placed.push({
        ...item,
        pos: Math.max(0, Math.min(1, cursor + jitter))
      });
      cursor += spacing;
    }
  }

  // Initial order by dither coordinates
  placed.sort((a, b) => a.pos - b.pos);

  // 4. Consecutive Similarity Smoothing Pass
  // If adjacent songs share the exact same Artist OR (Genre AND Vibe), swap with a nearby candidate
  const result = [...placed];
  for (let i = 0; i < result.length - 1; i++) {
    const curr = result[i].attr;
    const next = result[i + 1].attr;

    const isSameArtist = curr.artist === next.artist && curr.artist !== 'unknown';
    const isSameVibeGenre = curr.genre === next.genre && curr.vibe === next.vibe;

    if (isSameArtist || isSameVibeGenre) {
      // Lookahead window to find a contrasting track to swap
      for (let j = i + 2; j < Math.min(result.length, i + 6); j++) {
        const candidate = result[j].attr;
        if (candidate.artist !== curr.artist && candidate.genre !== curr.genre) {
          [result[i + 1], result[j]] = [result[j], result[i + 1]];
          break;
        }
      }
    }
  }

  return result.map(p => p.song);
}

export default function App() {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [currentTrack, setCurrentTrack] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [isMuted, setIsMuted] = useState(false);
  const [recentTracks, setRecentTracks] = useState([]);

  // Mobile drawer state
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  // Pagination state (25 tracks per page)
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 25;

  // Shuffle & Repeat state
  const [isShuffle, setIsShuffle] = useState(false);
  const [repeatMode, setRepeatMode] = useState('off'); // 'off' | 'all' | 'one'
  const [shuffledQueue, setShuffledQueue] = useState([]);

  const audioRefA = useRef(null);
  const audioRefB = useRef(null);
  const activeDeckRef = useRef('A'); // 'A' or 'B'
  const isCrossfadingRef = useRef(false);
  const fadeIntervalRef = useRef(null);
  const preloadedTrackRef = useRef(null);

  // Helper get active & inactive audio element
  const getActiveAudio = () => activeDeckRef.current === 'A' ? audioRefA.current : audioRefB.current;
  const getInactiveAudio = () => activeDeckRef.current === 'A' ? audioRefB.current : audioRefA.current;

  // Default recommendations on first load
  useEffect(() => {
    handleSearch('Top Indonesian Hits');
  }, []);

  const handleSearch = async (queryToSearch) => {
    const q = queryToSearch || searchQuery;
    if (!q.trim()) return;

    setIsLoading(true);
    setIsMobileMenuOpen(false);
    setCurrentPage(1);
    try {
      // Ambil hingga 50 lagu agar antrean shuffle kaya dan variatif
      const res = await fetch(`${API_BASE}/search?q=${encodeURIComponent(q)}&limit=50`);
      const data = await res.json();
      if (data && data.results) {
        setSearchResults(data.results);
        if (isShuffle) {
          setShuffledQueue(spotifyBalancedShuffle(data.results));
        }
      }
    } catch (err) {
      console.error('Search error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleShuffle = () => {
    const nextShuffle = !isShuffle;
    setIsShuffle(nextShuffle);
    if (nextShuffle) {
      setShuffledQueue(spotifyBalancedShuffle(searchResults));
    }
  };

  const cycleRepeatMode = () => {
    if (repeatMode === 'off') setRepeatMode('all');
    else if (repeatMode === 'all') setRepeatMode('one');
    else setRepeatMode('off');
  };

  const performCrossfade = (incomingAudio, outgoingAudio, targetVolume, durationMs = 2000) => {
    if (fadeIntervalRef.current) {
      clearInterval(fadeIntervalRef.current);
      fadeIntervalRef.current = null;
    }

    isCrossfadingRef.current = true;
    const steps = 20;
    const intervalTime = durationMs / steps;
    let step = 0;

    incomingAudio.volume = 0;
    incomingAudio.play().catch(e => console.log('Crossfade play error:', e));

    fadeIntervalRef.current = setInterval(() => {
      step++;
      const progress = step / steps; // 0.0 -> 1.0

      // Equal-power crossfade curve
      const gainOut = Math.cos(progress * 0.5 * Math.PI);
      const gainIn = Math.sin(progress * 0.5 * Math.PI);

      if (outgoingAudio) {
        outgoingAudio.volume = Math.max(0, Math.min(1, targetVolume * gainOut));
      }
      if (incomingAudio) {
        incomingAudio.volume = Math.max(0, Math.min(1, targetVolume * gainIn));
      }

      if (step >= steps) {
        clearInterval(fadeIntervalRef.current);
        fadeIntervalRef.current = null;
        if (outgoingAudio) {
          outgoingAudio.pause();
          outgoingAudio.volume = 0;
        }
        if (incomingAudio) {
          incomingAudio.volume = targetVolume;
        }
        isCrossfadingRef.current = false;
      }
    }, intervalTime);
  };

  const playTrack = async (track, options = { crossfade: true }) => {
    setIsResolving(true);
    try {
      const res = await fetch(`${API_BASE}/resolve?id=${track.id}`);
      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`);
      }
      const data = await res.json();
      if (!data || !data.stream_url) {
        throw new Error('No stream url received');
      }

      // Pastikan fallback thumbnail selalu ada URL valid
      const safeThumbnail = data.thumbnail || `https://i.ytimg.com/vi/${data.id || track.id}/hqdefault.jpg`;
      const cleanData = { ...data, thumbnail: safeThumbnail };
      
      setCurrentTrack(cleanData);
      setIsPlaying(true);
      
      setRecentTracks(prev => {
        const filtered = prev.filter(t => t.id !== cleanData.id);
        return [cleanData, ...filtered].slice(0, 8);
      });

      const currentActive = getActiveAudio();
      const nextDeck = activeDeckRef.current === 'A' ? 'B' : 'A';
      const nextAudio = nextDeck === 'A' ? audioRefA.current : audioRefB.current;
      const targetVol = isMuted ? 0 : volume;

      if (!nextAudio) return;

      if (options.crossfade && currentActive && !currentActive.paused && currentActive.currentTime > 0) {
        // Dual-deck DJ Crossfade
        nextAudio.src = cleanData.stream_url;
        activeDeckRef.current = nextDeck;
        performCrossfade(nextAudio, currentActive, targetVol, 2000);
      } else {
        // Direct playback
        activeDeckRef.current = nextDeck;
        if (currentActive) {
          try {
            currentActive.pause();
            currentActive.volume = 0;
          } catch (e) {}
        }
        nextAudio.src = cleanData.stream_url;
        nextAudio.volume = targetVol;
        nextAudio.play().catch(e => {
          if (e.name !== 'AbortError') {
            console.log('Playback error:', e);
          }
        });
      }
    } catch (err) {
      console.error('Resolve error:', err);
      // Hindari alert spam jika user klik cepat
    } finally {
      setIsResolving(false);
    }
  };

  const getEffectiveQueue = useCallback(() => {
    return (isShuffle && shuffledQueue.length > 0) ? shuffledQueue : searchResults;
  }, [isShuffle, shuffledQueue, searchResults]);

  const fetchInfiniteRelatedTracks = async (trackId) => {
    try {
      const res = await fetch(`${API_BASE}/related?id=${trackId}`);
      const data = await res.json();
      if (data && data.results && data.results.length > 0) {
        setSearchResults(prev => {
          const existingIds = new Set(prev.map(t => t.id));
          const newUnique = data.results.filter(t => !existingIds.has(t.id));
          if (newUnique.length === 0) return prev;
          
          const combined = [...prev, ...newUnique];
          if (isShuffle) {
            setShuffledQueue(spotifyBalancedShuffle(combined));
          }
          return combined;
        });
      }
    } catch (e) {
      console.log('Infinite discovery fetch error:', e);
    }
  };

  const handleNextTrack = useCallback(() => {
    const queue = getEffectiveQueue();
    if (!queue || queue.length === 0 || !currentTrack) return;

    const currentIndex = queue.findIndex(t => t.id === currentTrack.id);
    if (currentIndex === -1) {
      playTrack(queue[0]);
      return;
    }

    // Auto-fetch related jika mendekati ujung antrean (Infinite Radio Mode)
    if (currentIndex >= queue.length - 3) {
      fetchInfiniteRelatedTracks(currentTrack.id);
    }

    if (currentIndex < queue.length - 1) {
      playTrack(queue[currentIndex + 1]);
    } else {
      // Jika sudah benar-benar di ujung antrean:
      // Loop kembali ke awal jika repeatMode === 'all' ATAU dalam mode Shuffle tak terbatas
      if (repeatMode === 'all' || isShuffle) {
        // Dalam mode shuffle, generate urutan acak dither baru agar tidak pernah berhenti
        if (isShuffle) {
          const freshShuffle = spotifyBalancedShuffle(queue);
          setShuffledQueue(freshShuffle);
          playTrack(freshShuffle[0]);
        } else {
          playTrack(queue[0]);
        }
      } else {
        setIsPlaying(false);
      }
    }
  }, [getEffectiveQueue, currentTrack, repeatMode, isShuffle]);

  const handlePrevTrack = useCallback(() => {
    const queue = getEffectiveQueue();
    if (!queue || queue.length === 0 || !currentTrack) return;

    const currentAudio = getActiveAudio();
    if (currentAudio && currentAudio.currentTime > 3) {
      currentAudio.currentTime = 0;
      return;
    }

    const currentIndex = queue.findIndex(t => t.id === currentTrack.id);
    if (currentIndex > 0) {
      playTrack(queue[currentIndex - 1]);
    } else if (repeatMode === 'all') {
      playTrack(queue[queue.length - 1]);
    } else {
      if (currentAudio) currentAudio.currentTime = 0;
    }
  }, [getEffectiveQueue, currentTrack, repeatMode]);

  const handleTrackEnded = () => {
    if (repeatMode === 'one') {
      const activeAudio = getActiveAudio();
      if (activeAudio) {
        activeAudio.currentTime = 0;
        activeAudio.play().catch(e => console.log(e));
      }
      return;
    }
    handleNextTrack();
  };

  // Setup MediaSession API (Lockscreen & Background audio controls)
  useEffect(() => {
    if (!('mediaSession' in navigator) || !currentTrack) return;

    try {
      const artworkList = [];
      const thumb = currentTrack.thumbnail || (currentTrack.id ? `https://i.ytimg.com/vi/${currentTrack.id}/hqdefault.jpg` : '');
      if (thumb && typeof thumb === 'string' && thumb.startsWith('http')) {
        artworkList.push(
          { src: thumb, sizes: '96x96', type: 'image/jpeg' },
          { src: thumb, sizes: '128x128', type: 'image/jpeg' },
          { src: thumb, sizes: '192x192', type: 'image/jpeg' },
          { src: thumb, sizes: '512x512', type: 'image/jpeg' }
        );
      }

      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentTrack.title || 'MusicGueh Track',
        artist: currentTrack.uploader || 'YouTube Music',
        album: 'MusicGueh Ad-Free Player',
        artwork: artworkList
      });
    } catch (e) {
      console.log('MediaSession metadata error:', e);
    }

    navigator.mediaSession.setActionHandler('play', () => {
      const active = getActiveAudio();
      if (active) {
        active.play();
        setIsPlaying(true);
      }
    });

    navigator.mediaSession.setActionHandler('pause', () => {
      const active = getActiveAudio();
      if (active) {
        active.pause();
        setIsPlaying(false);
      }
    });

    navigator.mediaSession.setActionHandler('previoustrack', () => {
      handlePrevTrack();
    });

    navigator.mediaSession.setActionHandler('nexttrack', () => {
      handleNextTrack();
    });

    navigator.mediaSession.setActionHandler('seekto', (details) => {
      const active = getActiveAudio();
      if (details.seekTime && active) {
        active.currentTime = details.seekTime;
        setCurrentTime(details.seekTime);
      }
    });
  }, [currentTrack, handleNextTrack, handlePrevTrack]);

  // Sync media session playback state
  useEffect(() => {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    }
  }, [isPlaying]);

  const togglePlay = () => {
    const active = getActiveAudio();
    if (!active || !currentTrack) return;
    if (isPlaying) {
      active.pause();
      setIsPlaying(false);
    } else {
      active.play().catch(e => console.log('Resume error:', e));
      setIsPlaying(true);
    }
  };

  const onTimeUpdate = (deck) => {
    // Only track time from currently active deck
    if (activeDeckRef.current !== deck) return;
    const active = deck === 'A' ? audioRefA.current : audioRefB.current;
    if (active) {
      setCurrentTime(active.currentTime);
      setDuration(active.duration || 0);

      // Gapless Auto-Trigger: Pre-trigger next track 2.5 detik sebelum habis untuk fade out/in mulus
      const timeLeft = (active.duration || 0) - active.currentTime;
      if (active.duration > 5 && timeLeft <= 2.5 && !isCrossfadingRef.current && repeatMode !== 'one') {
        handleNextTrack();
      }

      if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession && active.duration) {
        try {
          navigator.mediaSession.setPositionState({
            duration: active.duration || 0,
            playbackRate: active.playbackRate || 1,
            position: active.currentTime || 0
          });
        } catch (e) {
          // ignore transient seek state errors
        }
      }
    }
  };

  const handleSeek = (e) => {
    const seekTime = parseFloat(e.target.value);
    const active = getActiveAudio();
    if (active) {
      active.currentTime = seekTime;
      setCurrentTime(seekTime);
    }
  };

  const handleVolumeChange = (e) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    const active = getActiveAudio();
    if (active && !isCrossfadingRef.current) {
      active.volume = val;
      setIsMuted(val === 0);
    }
  };

  const toggleMute = () => {
    const active = getActiveAudio();
    if (active) {
      if (isMuted) {
        const restored = volume || 0.5;
        active.volume = restored;
        setIsMuted(false);
      } else {
        active.volume = 0;
        setIsMuted(true);
      }
    }
  };

  const formatTime = (secs) => {
    if (isNaN(secs)) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  // Pagination calculations
  const totalPages = Math.ceil(searchResults.length / itemsPerPage) || 1;
  const paginatedResults = searchResults.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  return (
    <div className="flex flex-col h-[100dvh] bg-[#FFFDF5] text-[#121212] select-none overflow-hidden font-sans">
      {/* Dual Deck Audio Elements for Gapless Crossfade (Deck A & Deck B) */}
      <audio 
        ref={audioRefA}
        playsInline={true}
        webkit-playsinline="true"
        x-webkit-airplay="allow"
        preload="auto"
        onTimeUpdate={() => onTimeUpdate('A')}
        onEnded={handleTrackEnded}
        onPlay={() => { if (activeDeckRef.current === 'A') setIsPlaying(true); }}
        onPause={() => { if (activeDeckRef.current === 'A' && !isCrossfadingRef.current) setIsPlaying(false); }}
        onError={() => { if (activeDeckRef.current === 'A') setIsPlaying(false); }}
      />
      <audio 
        ref={audioRefB}
        playsInline={true}
        webkit-playsinline="true"
        x-webkit-airplay="allow"
        preload="auto"
        onTimeUpdate={() => onTimeUpdate('B')}
        onEnded={handleTrackEnded}
        onPlay={() => { if (activeDeckRef.current === 'B') setIsPlaying(true); }}
        onPause={() => { if (activeDeckRef.current === 'B' && !isCrossfadingRef.current) setIsPlaying(false); }}
        onError={() => { if (activeDeckRef.current === 'B') setIsPlaying(false); }}
      />

      {/* Top Banner Ticker */}
      <div className="bg-[#000000] text-[#FFE600] font-mono-brutal text-[11px] sm:text-xs py-1.5 px-3 sm:px-4 flex items-center justify-between border-b-[3px] border-black tracking-wider uppercase shrink-0">
        <span className="flex items-center gap-1.5 sm:gap-2 truncate">
          <Zap className="w-3.5 h-3.5 fill-[#FFE600] text-black shrink-0 animate-bounce" />
          <span className="truncate">MUSICGUEH // RAW AUDIO NO ADS // ALL OS SUPPORT</span>
        </span>
        <span className="hidden md:inline-block bg-[#FFE600] text-black px-2 py-0.5 text-[10px] font-bold border border-black shadow-[2px_2px_0px_#000]">
          BACKGROUND MEDIA READY
        </span>
      </div>

      <div className="flex flex-1 overflow-hidden relative">
        {/* Desktop Sidebar Navigation */}
        <aside className="w-72 bg-[#FFFDF5] p-5 flex-col gap-5 border-r-[3px] border-black hidden lg:flex shrink-0">
          {/* Logo Brand */}
          <div className="flex items-center gap-3 p-3 bg-[#FFE600] border-[3px] border-black rounded-xl shadow-[4px_4px_0px_#000] transition-transform hover:-rotate-1">
            <div className="bg-black text-[#FFE600] p-2 rounded-lg border-2 border-black">
              <Radio className="w-6 h-6 animate-pulse" />
            </div>
            <div>
              <h1 className="font-display font-extrabold text-xl leading-tight tracking-tight text-black">
                MusicGueh
              </h1>
              <p className="text-[11px] font-bold text-black flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5" /> Ad-Free Player
              </p>
            </div>
          </div>

          {/* Preset Buttons */}
          <nav className="flex flex-col gap-2.5">
            <button 
              onClick={() => handleSearch('Top Trending Songs')}
              className="brutal-btn flex items-center gap-3 px-3.5 py-2.5 rounded-xl bg-white border-[2.5px] border-black shadow-[3px_3px_0px_#000] hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[5px_5px_0px_#000] text-sm font-bold cursor-pointer"
            >
              <div className="p-1 bg-[#4ADE80] border-2 border-black rounded-md">
                <Music className="w-4 h-4 text-black" />
              </div>
              Trending Hits
            </button>
            <button 
              onClick={() => handleSearch('Spotify Global Top 50')}
              className="brutal-btn flex items-center gap-3 px-3.5 py-2.5 rounded-xl bg-white border-[2.5px] border-black shadow-[3px_3px_0px_#000] hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[5px_5px_0px_#000] text-sm font-bold cursor-pointer"
            >
              <div className="p-1 bg-[#7DD3FC] border-2 border-black rounded-md">
                <Disc3 className="w-4 h-4 text-black" />
              </div>
              Spotify Charts
            </button>
            <button 
              onClick={() => handleSearch('YouTube Music Indonesia Top')}
              className="brutal-btn flex items-center gap-3 px-3.5 py-2.5 rounded-xl bg-white border-[2.5px] border-black shadow-[3px_3px_0px_#000] hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[5px_5px_0px_#000] text-sm font-bold cursor-pointer"
            >
              <div className="p-1 bg-[#FF80BF] border-2 border-black rounded-md">
                <Flame className="w-4 h-4 text-black" />
              </div>
              YouTube Top Hits
            </button>
          </nav>

          {/* Recently Played */}
          <div className="flex-1 overflow-y-auto pr-1 bg-white border-[2.5px] border-black rounded-xl p-3 shadow-[4px_4px_0px_#000]">
            <h3 className="text-xs font-mono-brutal uppercase tracking-wider text-black font-extrabold mb-3 px-1 flex items-center justify-between">
              <span>RIWAYAT PUTAR</span>
              <span className="text-[10px] bg-[#FFE600] px-1.5 py-0.5 border border-black rounded">
                {recentTracks.length}
              </span>
            </h3>
            <div className="flex flex-col gap-2">
              {recentTracks.map((t) => (
                <button
                  key={t.id}
                  onClick={() => playTrack(t)}
                  className={`brutal-btn flex items-center gap-2.5 p-2 rounded-lg border-2 border-black transition-all text-left group cursor-pointer shadow-[2px_2px_0px_#000] ${
                    currentTrack?.id === t.id ? 'bg-[#FEF08A] translate-x-1 shadow-[3px_3px_0px_#000]' : 'bg-[#FFFDF5] hover:bg-[#FEF08A]'
                  }`}
                >
                  <img src={t.thumbnail} alt="" className="w-9 h-9 rounded border-2 border-black object-cover" />
                  <div className="overflow-hidden flex-1">
                    <p className="text-xs font-bold truncate text-black">{t.title}</p>
                    <p className="text-[10px] font-semibold text-stone-600 truncate">{t.uploader}</p>
                  </div>
                  {currentTrack?.id === t.id && isPlaying && (
                    <div className="flex items-end gap-0.5 h-3 shrink-0">
                      <span className="w-1 bg-black rounded-full animate-wave-1"></span>
                      <span className="w-1 bg-black rounded-full animate-wave-2"></span>
                      <span className="w-1 bg-black rounded-full animate-wave-3"></span>
                    </div>
                  )}
                </button>
              ))}
              {recentTracks.length === 0 && (
                <p className="text-xs font-semibold text-stone-500 p-2 italic text-center">
                  Belum ada lagu
                </p>
              )}
            </div>
          </div>

          {/* Info Card */}
          <div className="p-3 bg-[#7DD3FC] rounded-xl border-[2.5px] border-black shadow-[4px_4px_0px_#000] text-xs font-bold">
            <div className="flex items-center justify-between mb-1">
              <span>OS BACKGROUND PLAY</span>
              <span className="text-[10px] bg-black text-[#FFE600] px-1.5 py-0.5 rounded border border-black font-mono-brutal">LOCKED OK</span>
            </div>
            <p className="text-[11px] font-semibold text-black leading-snug">
              Mendukung MediaSession API: lagu tetap jalan di lockscreen Android & iOS.
            </p>
          </div>
        </aside>

        {/* Mobile Navigation Drawer Overlay */}
        {isMobileMenuOpen && (
          <div className="fixed inset-0 z-40 bg-black/60 lg:hidden flex transition-opacity animate-in fade-in duration-150">
            <div className="w-4/5 max-w-xs bg-[#FFFDF5] h-full border-r-[3.5px] border-black p-4 flex flex-col gap-4 shadow-[8px_0px_0px_#000] animate-in slide-in-from-left duration-200">
              <div className="flex items-center justify-between pb-3 border-b-2 border-black">
                <div className="flex items-center gap-2">
                  <div className="bg-[#FFE600] p-1.5 border-2 border-black rounded-lg">
                    <Radio className="w-5 h-5 text-black" />
                  </div>
                  <span className="font-display font-extrabold text-lg text-black">Menu Musik</span>
                </div>
                <button 
                  onClick={() => setIsMobileMenuOpen(false)}
                  className="brutal-btn bg-white p-1.5 border-2 border-black rounded-lg shadow-[2px_2px_0px_#000] cursor-pointer"
                >
                  <X className="w-5 h-5 text-black" />
                </button>
              </div>

              <nav className="flex flex-col gap-2">
                <button 
                  onClick={() => handleSearch('Top Trending Songs')}
                  className="brutal-btn flex items-center gap-3 px-3 py-2 rounded-xl bg-white border-2 border-black shadow-[3px_3px_0px_#000] text-xs font-bold"
                >
                  <Music className="w-4 h-4 text-emerald-600" /> Trending Hits
                </button>
                <button 
                  onClick={() => handleSearch('Spotify Global Top 50')}
                  className="brutal-btn flex items-center gap-3 px-3 py-2 rounded-xl bg-white border-2 border-black shadow-[3px_3px_0px_#000] text-xs font-bold"
                >
                  <Disc3 className="w-4 h-4 text-sky-600" /> Spotify Charts
                </button>
                <button 
                  onClick={() => handleSearch('YouTube Music Indonesia Top')}
                  className="brutal-btn flex items-center gap-3 px-3 py-2 rounded-xl bg-white border-2 border-black shadow-[3px_3px_0px_#000] text-xs font-bold"
                >
                  <Flame className="w-4 h-4 text-rose-600" /> YouTube Top Hits
                </button>
              </nav>

              <div className="flex-1 overflow-y-auto bg-white border-2 border-black rounded-xl p-2.5 shadow-[3px_3px_0px_#000]">
                <h4 className="text-[11px] font-mono-brutal font-extrabold mb-2 uppercase">Riwayat Putar</h4>
                <div className="flex flex-col gap-1.5">
                  {recentTracks.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => { playTrack(t); setIsMobileMenuOpen(false); }}
                      className="brutal-btn flex items-center gap-2 p-1.5 rounded-lg border border-black bg-[#FFFDF5] text-left"
                    >
                      <img src={t.thumbnail} alt="" className="w-8 h-8 rounded border border-black object-cover" />
                      <div className="overflow-hidden">
                        <p className="text-[11px] font-bold truncate text-black">{t.title}</p>
                        <p className="text-[9px] font-semibold text-stone-600 truncate">{t.uploader}</p>
                      </div>
                    </button>
                  ))}
                  {recentTracks.length === 0 && (
                    <p className="text-xs text-stone-400 italic text-center py-4">Belum ada riwayat</p>
                  )}
                </div>
              </div>
            </div>
            <div className="flex-1" onClick={() => setIsMobileMenuOpen(false)}></div>
          </div>
        )}

        {/* Main Content Area */}
        <main className="flex-1 flex flex-col overflow-hidden bg-transparent">
          {/* Header & Search Bar */}
          <header className="h-16 sm:h-20 border-b-[3px] border-black px-4 sm:px-6 flex items-center justify-between gap-2 sm:gap-4 bg-[#FFFDF5] z-10 shrink-0">
            {/* Mobile Hamburger Button */}
            <button
              onClick={() => setIsMobileMenuOpen(true)}
              className="brutal-btn lg:hidden bg-[#FFE600] p-2 border-2 border-black rounded-xl shadow-[3px_3px_0px_#000] cursor-pointer shrink-0"
              title="Menu"
            >
              <Menu className="w-5 h-5 text-black" />
            </button>

            <form 
              onSubmit={(e) => { e.preventDefault(); handleSearch(); }}
              className="flex-1 max-w-2xl relative"
            >
              <Search className="w-4 h-4 sm:w-5 sm:h-5 absolute left-3 sm:left-4 top-1/2 -translate-y-1/2 text-black transition-transform duration-200 focus-within:scale-110" />
              <input 
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Cari lagu, artis, atau genre..."
                className="w-full bg-white border-[2.5px] border-black rounded-xl pl-9 sm:pl-12 pr-16 sm:pr-24 py-2 sm:py-2.5 text-xs sm:text-sm font-bold text-black placeholder:text-stone-500 shadow-[2px_2px_0px_#000] sm:shadow-[3px_3px_0px_#000] focus:outline-none focus:bg-[#FFFDF0] focus:shadow-[5px_5px_0px_#000] transition-all"
              />
              <button
                type="submit"
                className="brutal-btn absolute right-1.5 sm:right-2 top-1/2 -translate-y-1/2 bg-[#FFE600] border-2 border-black px-2 sm:px-3 py-0.5 sm:py-1 text-[11px] sm:text-xs font-extrabold rounded-lg shadow-[1.5px_1.5px_0px_#000] cursor-pointer"
              >
                CARI
              </button>
            </form>

            <div className="hidden sm:flex items-center gap-3">
              <span className="text-xs bg-[#4ADE80] text-black font-extrabold px-3 py-1.5 rounded-xl border-[2.5px] border-black shadow-[3px_3px_0px_#000] flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-black animate-ping"></span>
                RESOLVER READY
              </span>
            </div>
          </header>

          {/* Content Body: Tracks Grid */}
          <div className="flex-1 overflow-y-auto p-3 sm:p-6 pb-32 sm:pb-36">
            <div className="flex items-center justify-between mb-4 sm:mb-5">
              <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
                <h2 className="font-display font-extrabold text-lg sm:text-2xl tracking-tight text-black">
                  KATALOG MUSIK
                </h2>
                <span className="bg-[#FF80BF] text-black text-[10px] sm:text-xs font-mono-brutal font-bold px-2 py-0.5 rounded border-2 border-black shadow-[2px_2px_0px_#000]">
                  HAL {currentPage} / {totalPages} ({searchResults.length} TOTAL)
                </span>
                {isShuffle && (
                  <span className="bg-[#FFE600] text-black text-[10px] font-mono-brutal font-bold px-2 py-0.5 rounded border-2 border-black shadow-[2px_2px_0px_#000] flex items-center gap-1 animate-pulse">
                    <Shuffle className="w-3 h-3" /> INFINITE SHUFFLE ACTIVE
                  </span>
                )}
              </div>
              {isLoading && (
                <span className="text-xs bg-white text-black font-bold px-2.5 py-1 rounded-lg border-2 border-black shadow-[2px_2px_0px_#000] flex items-center gap-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-black" />
                  <span className="hidden sm:inline">Mencari...</span>
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5 gap-3 sm:gap-5">
              {paginatedResults.map((track) => {
                const isCurrentActive = currentTrack?.id === track.id;
                return (
                  <div 
                    key={track.id}
                    className={`brutal-btn p-2.5 sm:p-3.5 rounded-2xl border-[2.5px] sm:border-[3px] border-black transition-all group cursor-pointer flex flex-col justify-between ${
                      isCurrentActive 
                        ? 'bg-[#FEF08A] shadow-[3px_3px_0px_0px_#000] -translate-x-0.5 -translate-y-0.5' 
                        : 'bg-white shadow-[4px_4px_0px_0px_#000] hover:-translate-x-1 hover:-translate-y-1 hover:shadow-[7px_7px_0px_0px_#000]'
                    }`}
                    onClick={() => playTrack(track)}
                  >
                    <div className="relative mb-2 sm:mb-3 aspect-square overflow-hidden rounded-xl border-2 border-black bg-stone-100">
                      <img 
                        src={track.thumbnail} 
                        alt={track.title} 
                        className={`w-full h-full object-cover transition-transform duration-500 ${
                          isCurrentActive && isPlaying ? 'scale-105' : 'group-hover:scale-105'
                        }`}
                        loading="lazy"
                      />
                      <div className={`absolute inset-0 bg-black/30 transition-opacity flex items-center justify-center ${
                        isCurrentActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                      }`}>
                        <button className="brutal-btn bg-[#FFE600] text-black p-2.5 sm:p-3.5 rounded-full border-[2.5px] border-black shadow-[3px_3px_0px_#000] group-hover:scale-110 active:scale-95 transition-all cursor-pointer">
                          {isCurrentActive && isPlaying ? (
                            <Pause className="w-5 h-5 sm:w-6 sm:h-6 fill-black" />
                          ) : (
                            <Play className="w-5 h-5 sm:w-6 sm:h-6 fill-black ml-0.5" />
                          )}
                        </button>
                      </div>

                      {/* Equalizer animation badge on playing item */}
                      {isCurrentActive && isPlaying && (
                        <div className="absolute top-2 right-2 bg-black text-[#FFE600] px-2 py-1 rounded-md border border-black flex items-center gap-1 shadow-[2px_2px_0px_#FFE600]">
                          <span className="w-1 bg-[#FFE600] rounded-full animate-wave-1"></span>
                          <span className="w-1 bg-[#FFE600] rounded-full animate-wave-2"></span>
                          <span className="w-1 bg-[#FFE600] rounded-full animate-wave-3"></span>
                        </div>
                      )}
                    </div>

                    <div>
                      <h3 className="font-display font-bold text-xs sm:text-sm line-clamp-1 group-hover:text-black transition-colors mb-0.5 sm:mb-1">
                        {track.title}
                      </h3>
                      <p className="text-[10px] sm:text-xs font-semibold text-stone-600 truncate mb-2 sm:mb-3">
                        {track.uploader}
                      </p>
                      <div className="flex items-center justify-between text-[10px] sm:text-xs font-bold pt-1.5 sm:pt-2.5 border-t-2 border-black bg-[#FFFBEB] -mx-2.5 -mb-2.5 sm:-mx-3.5 sm:-mb-3.5 p-2 sm:p-3 rounded-b-xl">
                        <span className="bg-[#7DD3FC] px-1.5 py-0.5 rounded border border-black text-[9px] sm:text-[10px] font-mono-brutal text-black shadow-[1px_1px_0px_#000]">
                          STREAM
                        </span>
                        <span className="font-mono-brutal text-stone-800 text-[10px] sm:text-xs">
                          {track.duration ? `${Math.floor(track.duration / 60)}:${(track.duration % 60).toString().padStart(2, '0')}` : 'RAW'}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Neo-Brutalism Pagination Controls */}
            {totalPages > 1 && (
              <div className="mt-8 mb-4 flex items-center justify-center gap-2 sm:gap-3 flex-wrap">
                <button
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="brutal-btn bg-white disabled:opacity-40 border-[2.5px] border-black px-3.5 py-1.5 rounded-xl shadow-[3px_3px_0px_#000] text-xs font-mono-brutal font-extrabold cursor-pointer disabled:cursor-not-allowed"
                >
                  PREV
                </button>

                {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
                  <button
                    key={page}
                    onClick={() => setCurrentPage(page)}
                    className={`brutal-btn border-[2.5px] border-black w-9 h-9 rounded-xl text-xs font-mono-brutal font-extrabold cursor-pointer flex items-center justify-center ${
                      currentPage === page
                        ? 'bg-[#FFE600] shadow-[1px_1px_0px_#000] translate-x-0.5 translate-y-0.5'
                        : 'bg-white shadow-[3px_3px_0px_#000] hover:bg-[#FEF08A]'
                    }`}
                  >
                    {page}
                  </button>
                ))}

                <button
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="brutal-btn bg-white disabled:opacity-40 border-[2.5px] border-black px-3.5 py-1.5 rounded-xl shadow-[3px_3px_0px_#000] text-xs font-mono-brutal font-extrabold cursor-pointer disabled:cursor-not-allowed"
                >
                  NEXT
                </button>
              </div>
            )}
          </div>

          {/* Bottom Persistent Audio Player Bar */}
          <footer className="fixed bottom-0 left-0 right-0 lg:static h-24 sm:h-28 bg-[#FFE600] border-t-[3.5px] border-black px-3 sm:px-6 flex items-center justify-between gap-2 sm:gap-6 z-30 shadow-[0_-4px_0px_0px_#000]">
            {/* Track Details with Vinyl Rotation Effect */}
            <div className="flex items-center gap-2 sm:gap-3 flex-1 lg:flex-none lg:w-1/4 min-w-0">
              {currentTrack ? (
                <>
                  <div className="relative shrink-0">
                    <img 
                      src={currentTrack.thumbnail} 
                      alt="" 
                      className={`w-12 h-12 sm:w-16 sm:h-16 rounded-full object-cover border-[2px] sm:border-[2.5px] border-black shadow-[2px_2px_0px_#000] bg-white ${
                        isPlaying ? 'animate-vinyl' : 'animate-vinyl animate-vinyl-paused'
                      }`}
                    />
                    <div className="absolute inset-0 m-auto w-3.5 h-3.5 sm:w-4 sm:h-4 bg-black rounded-full border border-white"></div>
                  </div>
                  <div className="overflow-hidden pr-2">
                    <h4 className="font-display text-xs sm:text-sm font-extrabold truncate text-black">
                      {currentTrack.title}
                    </h4>
                    <p className="text-[10px] sm:text-xs font-bold text-stone-800 truncate">
                      {currentTrack.uploader}
                    </p>
                    <div className="hidden sm:flex items-center gap-1.5 mt-0.5">
                      <span className="text-[9px] sm:text-[10px] bg-[#4ADE80] text-black font-mono-brutal font-bold px-1.5 py-0.2 border border-black rounded shadow-[1px_1px_0px_#000]">
                        PLAYING
                      </span>
                      {isPlaying && (
                        <div className="flex items-end gap-0.5 h-3">
                          <span className="w-0.5 bg-black rounded-full animate-wave-1"></span>
                          <span className="w-0.5 bg-black rounded-full animate-wave-2"></span>
                          <span className="w-0.5 bg-black rounded-full animate-wave-3"></span>
                          <span className="w-0.5 bg-black rounded-full animate-wave-4"></span>
                        </div>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-2 text-black text-xs font-bold italic">
                  <div className="w-11 h-11 sm:w-16 sm:h-16 rounded-xl bg-white border-2 border-black shadow-[2px_2px_0px_#000] flex items-center justify-center shrink-0">
                    <Music className="w-5 h-5 sm:w-7 sm:h-7 text-black" />
                  </div>
                  <span className="truncate text-[11px] sm:text-xs">Pilih lagu</span>
                </div>
              )}
            </div>

            {/* Controls & Progress Center */}
            <div className="flex flex-col items-center gap-1 sm:gap-2 flex-1 max-w-xl">
              <div className="flex items-center gap-2 sm:gap-4">
                {/* Shuffle Button */}
                <button 
                  onClick={toggleShuffle}
                  title="Spotify Balanced Shuffle"
                  className={`brutal-btn p-1.5 sm:p-2 rounded-xl border-2 border-black cursor-pointer ${
                    isShuffle 
                      ? 'bg-[#FF80BF] shadow-[1px_1px_0px_#000] translate-x-0.5 translate-y-0.5' 
                      : 'bg-white shadow-[2px_2px_0px_#000]'
                  }`}
                >
                  <Shuffle className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-black" />
                </button>

                {/* Skip Back */}
                <button 
                  onClick={handlePrevTrack}
                  disabled={!currentTrack}
                  className="brutal-btn bg-white p-1.5 sm:p-2 rounded-xl border-2 border-black shadow-[2px_2px_0px_#000] cursor-pointer disabled:opacity-50"
                >
                  <SkipBack className="w-4 h-4 sm:w-5 sm:h-5 text-black" />
                </button>

                {/* Play / Pause */}
                <button 
                  onClick={togglePlay}
                  disabled={!currentTrack || isResolving}
                  className="brutal-btn bg-[#000000] text-[#FFE600] p-2.5 sm:p-3 rounded-2xl border-[2.5px] border-black shadow-[3px_3px_0px_#000] sm:shadow-[4px_4px_0px_#000] cursor-pointer disabled:opacity-50"
                >
                  {isResolving ? (
                    <Loader2 className="w-5 h-5 sm:w-6 sm:h-6 animate-spin text-[#FFE600]" />
                  ) : isPlaying ? (
                    <Pause className="w-5 h-5 sm:w-6 sm:h-6 fill-current" />
                  ) : (
                    <Play className="w-5 h-5 sm:w-6 sm:h-6 fill-current ml-0.5" />
                  )}
                </button>

                {/* Skip Forward */}
                <button 
                  onClick={handleNextTrack}
                  disabled={!currentTrack}
                  className="brutal-btn bg-white p-1.5 sm:p-2 rounded-xl border-2 border-black shadow-[2px_2px_0px_#000] cursor-pointer disabled:opacity-50"
                >
                  <SkipForward className="w-4 h-4 sm:w-5 sm:h-5 text-black" />
                </button>

                {/* Repeat Button */}
                <button 
                  onClick={cycleRepeatMode}
                  title={`Repeat: ${repeatMode}`}
                  className={`brutal-btn p-1.5 sm:p-2 rounded-xl border-2 border-black cursor-pointer ${
                    repeatMode !== 'off' 
                      ? 'bg-[#4ADE80] shadow-[1px_1px_0px_#000] translate-x-0.5 translate-y-0.5' 
                      : 'bg-white shadow-[2px_2px_0px_#000]'
                  }`}
                >
                  {repeatMode === 'one' ? (
                    <Repeat1 className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-black" />
                  ) : (
                    <Repeat className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-black" />
                  )}
                </button>
              </div>

              {/* Progress Slider */}
              <div className="w-full flex items-center gap-2 sm:gap-3 text-[10px] sm:text-xs font-mono-brutal font-bold text-black">
                <span className="w-9 sm:w-12 text-right">{formatTime(currentTime)}</span>
                <input 
                  type="range"
                  min="0"
                  max={duration || 100}
                  value={currentTime}
                  onChange={handleSeek}
                  className="w-full h-2 sm:h-2.5 bg-white border-2 border-black rounded-lg appearance-none cursor-pointer shadow-[1px_1px_0px_#000] sm:shadow-[2px_2px_0px_#000] transition-all hover:scale-[1.01]"
                />
                <span className="w-9 sm:w-12">{formatTime(duration)}</span>
              </div>
            </div>

            {/* Volume Control (Desktop Only) */}
            <div className="hidden lg:flex items-center justify-end gap-3 w-1/4">
              <button 
                onClick={toggleMute} 
                className="brutal-btn bg-white p-2 rounded-xl border-2 border-black shadow-[3px_3px_0px_#000] cursor-pointer text-black"
              >
                {isMuted || volume === 0 ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
              </button>
              <input 
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={isMuted ? 0 : volume}
                onChange={handleVolumeChange}
                className="w-24 h-2.5 bg-white border-2 border-black rounded-lg appearance-none cursor-pointer shadow-[2px_2px_0px_#000]"
              />
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
}
