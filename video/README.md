# 解説動画「Codexで作る “動く”パティスリーサイト」

`montblanc-site/`（栗のモンブランLP）を素材にした 16:9 / 1920×1080 / 30fps・約117秒の解説動画です。
動画は HTML + GSAP のタイムラインで組み、Playwright で1フレームずつ書き出して MP4 にしています。

## 構成（タイムライン）

| 時間 | シーン | 内容 |
|---|---|---|
| 0:00 | フック | 0.4〜0.5秒の高速カット → 「動く。のぞける。」「AIで、つくった。」 |
| 0:07 | 完成サイト紹介 | ブラウザモックアップで実サイトを再生（**1.25倍速**）、POINT吹き出し、虫眼鏡で断面、スクロール、スクショの扇形展開 |
| 0:22 | タイトル | 「Codexで作る “動く”パティスリーサイト」 |
| 0:27 | 全体の流れ | 6ステップのロードマップ図解 |
| 0:34 | STEP01 | Codexでプロジェクト作成（新規プロジェクト→名前→フォルダ） |
| 0:44 | STEP02 | プロンプト入力＋「目的・雰囲気・動き」の3要素図解 |
| 0:57 | STEP03 | Codexの生成画面（作業ログ・diff）→ 生成コードのツアー |
| 1:10 | STEP04 | 絞りアニメの仕組み（stroke-dashoffset 図解・34本の時間差） |
| 1:22 | STEP05 | 虫眼鏡エフェクト（3レイヤー分解図・コード・ライブデモ） |
| 1:36 | STEP06 | 日本語で追加注文 → ビフォーアフター → 公開 |
| 1:47 | まとめ | チェックリスト・ラストカット・エンドカード |

※ Codex の画面は説明用に再現したモックアップです（画面内に「※画面はイメージです」と表記）。

## 書き出し手順

```bash
cd video
npm install                      # gsap / fontsource
pip install numpy imageio-ffmpeg
(cd .. && npx http-server -p 8080 -c-1 -s &)   # リポジトリ直下を配信

node capture-shots.js            # サイトのスクショ素材 → assets/
node preview.js 8.5 14 60        # 指定秒のフレームを shots/ に確認用出力
node render.js out/video_noaudio.mp4 30     # 映像（sfx.json も出力）
python3 audio.py 117             # BGM＋効果音 → out/audio.wav
ffmpeg -i out/video_noaudio.mp4 -i out/audio.wav -c:v copy -c:a aac -b:a 192k -shortest out/codex-montblanc-tutorial.mp4
```

## 調整ポイント

- 字幕・テロップ：`index.html` の `sub(開始, 終了, "テキスト")` と各シーンのブロック
- デモサイトの再生速度：`SITE_SPEED`（既定 1.25）
- 実際の Codex 画面収録に差し替える場合は、各 `.cx` モックアップを `<video>` / `<img>` に置き換える
