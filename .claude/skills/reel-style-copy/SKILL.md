---
name: reel-style-copy
description: ユーザーのリール動画（縦型・話している動画）に、お手本リールと同じスタイルのテロップ（フォント・装飾・四角の囲み・出方・テンポ）を入れて完成mp4を作るスキル。「リールに文字を入れて」「お手本と同じ感じで」「いつものリール」「リール作って」と言われたとき、または縦型動画ファイルが渡されてテロップ入れを求められたときに必ず使う。修正なしで一発で仕上げることが目的。
---

# リール テロップ自動作成（お手本スタイル固定）

目的：ユーザーから動画を受け取ったら、**質問を最小限にして、修正不要の完成mp4を1回で渡す**。
スタイルは `style.json` に固定してある。毎回ゼロから考えない。

## 絶対ルール

1. **お手本の音源は抜き出さない・動画に入れない**（著作権）。音楽はユーザーが投稿時にInstagramの「音源を使う」で付ける。完成mp4はユーザーの元音声のまま。最後に必ずこれを一言伝える。
2. Instagram へはこの環境から接続できない（プロキシが403）。URLを渡されたら試さず、**画面収録ファイルのアップロードを依頼**する。
3. 文字起こしモデル（huggingface等）もダウンロード不可。話の内容は**ユーザーに箇条書きでもらう**。もらえない場合は、動画のフレームと長さから推測せず、1回だけ依頼する。
4. スタイルは `style.json` の値だけを使う。勝手にアレンジしない。

## 手順

### 0. 準備（毎回）
```bash
pip install -q pillow imageio-ffmpeg
```
ffmpeg は `python3 -c "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())"` のパスを使う（システムにffmpegは無い）。

### 1. スタイルが確定しているか確認
`style.json` の `"analyzed"` を見る。
- `true` → 手順2へ（お手本の分析は不要）。
- `false` → お手本の画面収録を受け取り、`references/analyze-reference.md` の手順で分析して `style.json` を埋め、`"analyzed": true` にしてコミットする。**1回やれば以後は不要**。

### 2. 入力を受け取る
- ユーザーの動画（.mov/.mp4）。解像度が低い（幅720未満）ときは「元の画質で送れますか」と1回だけ聞き、なければそのまま進める（出力は1080x1920に拡大）。
- 話の内容（箇条書き可）。

### 3. テロップ台本 `captions.json` を作る
形式は `references/captions-example.json` を参照。ルール：
- 冒頭0〜3秒は `"type": "hook"`（一番目立つ四角囲み）。視聴者が止まる一言。
- 1枚のテロップは **全角14文字×2行以内**。長い文は分割する。
- 強調語は `"type": "box"`（四角囲み）、それ以外は `"type": "normal"`。boxは全体の3割以下。
- 表示時間は `style.json` の `rhythm`（1枚あたり秒数）に従い、隙間なく連続させる。
- 最後の2〜3秒は `"type": "cta"`（保存・フォロー促し）。
- タイミングは話に合わせる：音声の無音区間を検出して区切りの候補にする
  ```bash
  $FF -i input.mov -af silencedetect=n=-30dB:d=0.3 -f null - 2>&1 | grep silence_
  ```

### 4. レンダリング
```bash
python3 .claude/skills/reel-style-copy/scripts/render.py \
  --video input.mov --captions captions.json \
  --style .claude/skills/reel-style-copy/style.json --out output.mp4
```

### 5. 自己チェック（ユーザーに渡す前に必ず）
```bash
python3 .claude/skills/reel-style-copy/scripts/render.py --video input.mov \
  --captions captions.json --style .claude/skills/reel-style-copy/style.json \
  --out output.mp4 --preview preview.png
```
`preview.png`（各テロップの中間フレームを並べた一覧）を Read で見て確認：
- 文字が画面外にはみ出していない／顔にかぶっていない（かぶるなら `style.json` ではなく該当テロップを `"position": "top"` に）
- 1行が長すぎない、誤字がない
- hook・box・cta の見た目が `style.json` どおり
問題があれば直してから再レンダリング。**ユーザーに修正させない**。

### 6. 納品
- `output.mp4` を SendUserFile で送る。
- 一言添える：「音楽は投稿時にお手本リールの『音源を使う』から同じ曲を付けてください。音量は元の声が聞こえるよう下げてください。」
- 使ったテロップ文面を箇条書きで添える（キャプション投稿文にも使えるように）。
