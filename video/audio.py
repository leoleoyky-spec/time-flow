"""Synthesises the soundtrack (BGM + SFX) for the explainer video.

BGM: soft lo-fi jazz loop (pad, e-piano arpeggio, bass, light drums).
SFX: cue list exported from the composition (out/sfx.json).
usage: python3 audio.py [duration]  ->  out/audio.wav
"""
import json
import sys
import wave

import numpy as np

SR = 44100
DUR = float(sys.argv[1]) if len(sys.argv) > 1 else 117.0
N = int(SR * DUR)
rng = np.random.default_rng(7)
L = np.zeros(N)
R = np.zeros(N)


def midi(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def add(sig, t, gain=1.0, pan=0.0):
    i = int(t * SR)
    if i >= N or i + len(sig) <= 0:
        return
    if i < 0:
        sig, i = sig[-i:], 0
    sig = sig[: N - i]
    L[i:i + len(sig)] += sig * gain * np.sqrt((1 - pan) / 2) * 1.414
    R[i:i + len(sig)] += sig * gain * np.sqrt((1 + pan) / 2) * 1.414


def env(n, a=0.005, r=None, d=None):
    t = np.arange(n) / SR
    e = np.minimum(1, t / max(a, 1e-4))
    if d is not None:
        e *= np.exp(-t / d)
    if r is not None:
        e *= np.clip((n / SR - t) / r, 0, 1)
    return e


def bandnoise(n, lo, hi):
    x = rng.standard_normal(n)
    f = np.fft.rfft(x)
    fr = np.fft.rfftfreq(n, 1 / SR)
    f[(fr < lo) | (fr > hi)] = 0
    y = np.fft.irfft(f, n)
    return y / (np.abs(y).max() + 1e-9)


def sweep(n, f0, f1, curve=1.0):
    k = (np.arange(n) / n) ** curve
    f = f0 + (f1 - f0) * k
    return np.sin(2 * np.pi * np.cumsum(f) / SR)


# ------------------------------------------------------------------ BGM
BPM = 100
BEAT = 60 / BPM
BAR = BEAT * 4
CHORDS = [  # Fmaj9, Em7, Dm9, Cmaj7/G
    [53, 57, 60, 64, 67], [52, 55, 59, 62, 67], [50, 53, 57, 60, 64], [48, 52, 55, 59, 62],
]
DRUMS_OFF = [(0, 7.0), (22.4, 27.2), (114.4, DUR)]


def drums_on(t):
    return not any(a <= t < b for a, b in DRUMS_OFF)


def epiano(freq, n):
    t = np.arange(n) / SR
    s = np.sin(2 * np.pi * freq * t) + 0.35 * np.sin(4 * np.pi * freq * t) * np.exp(-t / 0.15) + 0.12 * np.sin(6 * np.pi * freq * t)
    return s * env(n, 0.004, d=0.55) * (1 + 0.08 * np.sin(2 * np.pi * 5 * t))


music_L = np.zeros(N)
music_R = np.zeros(N)
duck = np.ones(N)


def madd(sig, t, g, pan=0.0):
    i = int(t * SR)
    if i >= N:
        return
    sig = sig[: N - i]
    music_L[i:i + len(sig)] += sig * g * (1 - pan * 0.5)
    music_R[i:i + len(sig)] += sig * g * (1 + pan * 0.5)


t = 0.0
bar = 0
while t < DUR:
    ch = CHORDS[(bar // 2) % 4]
    # pad (2 bars)
    if bar % 2 == 0:
        n = int(BAR * 2 * SR) + SR
        tt = np.arange(n) / SR
        pad = np.zeros(n)
        for m in ch:
            for det in (-0.12, 0.12):
                pad += np.sin(2 * np.pi * midi(m + det) * tt + rng.uniform(0, 6))
        pad *= env(n, 0.8, r=1.2) / len(ch) / 2
        madd(pad, t, 0.16, pan=0.0)
        # bass
        for k in (0, 2.5, 4, 6.5):
            nb = int(BEAT * 1.4 * SR)
            tb = np.arange(nb) / SR
            b = np.sin(2 * np.pi * midi(ch[0] - 12) * tb) * env(nb, 0.01, d=0.6)
            if drums_on(t + k * BEAT):
                madd(b, t + k * BEAT, 0.22)
    # e-piano arpeggio in 8ths
    pattern = [0, 2, 4, 3, 1, 4, 2, 3]
    for s in range(8):
        tn = t + s * BEAT / 2
        if tn >= DUR:
            break
        m = ch[pattern[s] % len(ch)] + 12
        n = int(0.9 * SR)
        g = 0.07 if drums_on(tn) else 0.09
        madd(epiano(midi(m), n), tn + (0.012 if s % 2 else 0), g, pan=-0.6 + 0.15 * s)
    # drums
    for b in range(4):
        tb = t + b * BEAT
        if tb >= DUR or not drums_on(tb):
            continue
        if b in (0, 2):
            n = int(0.35 * SR)
            k = sweep(n, 120, 42, 0.4) * env(n, 0.002, d=0.12)
            madd(k, tb, 0.45)
            i = int(tb * SR)
            m = min(N - i, int(0.3 * SR))
            duck[i:i + m] = np.minimum(duck[i:i + m], 0.55 + 0.45 * np.linspace(0, 1, m) ** 0.7)
        if b in (1, 3):
            n = int(0.18 * SR)
            madd(bandnoise(n, 900, 5000) * env(n, 0.001, d=0.05), tb, 0.10)
        for h in range(2):
            n = int(0.05 * SR)
            madd(bandnoise(n, 7000, 16000) * env(n, 0.001, d=0.015), tb + h * BEAT / 2 + (0.02 if h else 0), 0.05 if h else 0.035, pan=0.4)
    t += BAR
    bar += 1

music_L *= duck
music_R *= duck
# master envelope: fade in / fade out
fade = np.ones(N)
fi = int(1.0 * SR)
fade[:fi] = np.linspace(0, 1, fi)
fo0 = int(115.4 * SR)
fade[fo0:] = np.linspace(1, 0, N - fo0)
L += music_L * fade
R += music_R * fade

# ------------------------------------------------------------------ SFX


def s_whoosh(d=0.55, lo=300, hi=3000):
    n = int(d * SR)
    x = bandnoise(n, lo, hi)
    e = np.sin(np.pi * np.linspace(0, 1, n)) ** 2
    return x * e


def s_hit():
    n = int(0.4 * SR)
    return bandnoise(n, 200, 6000) * env(n, 0.001, d=0.05) * 0.6 + sweep(n, 90, 40) * env(n, 0.002, d=0.15)


def s_boom():
    n = int(1.2 * SR)
    return sweep(n, 85, 28, 0.5) * env(n, 0.003, d=0.45) + bandnoise(n, 40, 900) * env(n, 0.002, d=0.12) * 0.5


def s_pop():
    n = int(0.09 * SR)
    return sweep(n, 520, 1250, 0.6) * env(n, 0.002, d=0.03)


def s_click():
    n = int(0.05 * SR)
    t = np.arange(n) / SR
    return (bandnoise(n, 2000, 9000) * env(n, 0.0005, d=0.004) + np.sin(2 * np.pi * 2600 * t) * env(n, 0.0005, d=0.01) * 0.5)


def s_key():
    n = int(0.04 * SR)
    t = np.arange(n) / SR
    f = rng.uniform(1800, 3200)
    return bandnoise(n, 1500, 8000) * env(n, 0.0005, d=0.006) * 0.8 + np.sin(2 * np.pi * f * t) * env(n, 0.0005, d=0.004) * 0.3


def s_tick():
    n = int(0.35 * SR)
    t = np.arange(n) / SR
    return (np.sin(2 * np.pi * 1760 * t) + 0.5 * np.sin(2 * np.pi * 2637 * t)) * env(n, 0.002, d=0.08)


def s_ding():
    n = int(1.4 * SR)
    t = np.arange(n) / SR
    return (np.sin(2 * np.pi * 1318.5 * t) + 0.7 * np.sin(2 * np.pi * 1975.5 * t) + 0.3 * np.sin(2 * np.pi * 2637 * t)) * env(n, 0.002, d=0.35) / 2


def s_shimmer():
    n = int(1.6 * SR)
    out = np.zeros(n)
    for k in range(14):
        m = rng.choice([84, 86, 88, 91, 93, 96, 98, 100])
        st = int(k * 0.07 * SR)
        nn = int(0.6 * SR)
        tt = np.arange(nn) / SR
        seg = np.sin(2 * np.pi * midi(m) * tt) * env(nn, 0.002, d=0.18)
        out[st:st + nn] += seg[: n - st]
    return out / 4


def s_glitch():
    n = int(0.25 * SR)
    x = bandnoise(n, 200, 8000)
    x = np.round(x * 4) / 4
    gate = (np.floor(np.arange(n) / (SR * 0.02)) % 2)
    return x * gate * 0.5


def s_riser(d):
    n = int(d * SR)
    k = np.linspace(0, 1, n)
    return (bandnoise(n, 400, 9000) * k ** 2 * 0.5 + sweep(n, 200, 1200, 2) * k ** 3 * 0.3)


cues = json.load(open("out/sfx.json"))
last = {}
for c in cues:
    t, ty = c["t"], c["type"]
    # avoid stacking identical cues on the same instant
    if ty in last and t - last[ty] < 0.05 and ty != "type":
        continue
    last[ty] = t
    if ty == "whoosh":
        add(s_whoosh(), t - 0.1, 0.35, pan=rng.uniform(-.4, .4))
    elif ty == "swish":
        add(s_whoosh(0.35, 1200, 7000), t, 0.25, pan=rng.uniform(-.5, .5))
    elif ty == "hit":
        add(s_hit(), t, 0.35)
    elif ty == "boom":
        add(s_boom(), t, 0.55)
    elif ty == "pop":
        add(s_pop(), t, 0.18, pan=rng.uniform(-.3, .3))
    elif ty == "click":
        add(s_click(), t, 0.4)
    elif ty == "tick":
        add(s_tick(), t, 0.12)
    elif ty == "ding":
        add(s_ding(), t, 0.25)
    elif ty == "shimmer":
        add(s_shimmer(), t, 0.3)
    elif ty == "glitch":
        add(s_glitch(), t, 0.3)
    elif ty == "riser":
        add(s_riser(c.get("dur", 2)), t, 0.35)
    elif ty == "type":
        tt = t
        while tt < t + c.get("dur", 1):
            add(s_key(), tt, 0.13, pan=rng.uniform(-.3, .3))
            tt += rng.uniform(0.045, 0.09)

# master: soft clip + normalise
mix = np.stack([L, R], axis=1)
mix = np.tanh(mix * 1.1)
mix = mix / np.abs(mix).max() * 0.89
pcm = (mix * 32767).astype(np.int16)
with wave.open("out/audio.wav", "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print("wrote out/audio.wav", DUR, "s,", len(cues), "cues")
