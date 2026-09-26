#!/bin/bash
# contact sheet of preview frames: sheet.sh out.jpg t1 t2 ...
F=/usr/local/lib/python3.11/dist-packages/imageio_ffmpeg/binaries/ffmpeg-linux-x86_64-v7.0.2
out=$1; shift; args=(); fl=""; i=0
for t in "$@"; do args+=(-i "f_$t.jpg"); fl+="[$i]scale=640:360[v$i];"; i=$((i+1)); done
n=$i; lay=""; for ((j=0;j<n;j++)); do x=$(( (j%3)*640 )); y=$(( (j/3)*360 )); lay+="${x}_${y}|"; done
ins=""; for ((j=0;j<n;j++)); do ins+="[v$j]"; done
$F -loglevel error -y "${args[@]}" -filter_complex "${fl}${ins}xstack=inputs=$n:layout=${lay%|}:fill=black" $out
