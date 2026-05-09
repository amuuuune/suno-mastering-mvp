# Suno Mastering Bench

Sunoなどで作った音源を、音楽知識が少なくても耳で比べながら整え、WAVマスターとして保存するためのローカルWebアプリです。

主出力は **Master WAV** です。MP3はSNS投稿や共有用の任意コピーとして扱います。

## 起動

普段は `launch.bat` をダブルクリックします。専用のブラウザウィンドウでアプリを開きます。

その専用ウィンドウを閉じると、バックエンドサーバーも自動停止します。

PowerShellから手動起動する場合は、このディレクトリに移動して実行します。

```powershell
.\start_backend.ps1
```

起動後に開くURL:

```text
http://127.0.0.1:18765/
```

## 現在の位置づけ

プロのマスタリングエンジニアを完全代替するものではありません。

現時点では、Suno音源を安全に整え、WAVマスターを書き出し、ffmpegの2パス `loudnorm` でLUFS/True Peakを確認できる実用ベータです。

## 主な機能

- WAV/MP3/FLACなどの読み込み
- 波形表示、再生、停止、シーク
- Before/After切り替え
- 音量マッチ付きA/B比較
- 基本補正
- 明るさ、太さ、迫力、広がり、なめらかさの直感スライダー
- Natural、Bright、Warm、Loud、Vocal、Wide、Smoothプリセット
- ルックアヘッドリミッター
- 動的なめらかさ処理
- ffmpeg精密解析
- 24bit/16bit WAV書き出し
- 320kbps MP3コピー
- 書き出し後のLUFS/True Peak/LRA表示

## ffmpeg

このプロジェクトでは `tools/ffmpeg/ffmpeg.exe` を優先して使います。

見つからない場合は、PATHや既知のローカル候補も探します。`tools/ffmpeg/ffmpeg.exe` は `.gitignore` 対象です。巨大な実行ファイルなのでリポジトリには入れない方針です。

## 仕様と検査

要件と仕様は `docs/` に固定しています。

- [仕様ドキュメント索引](docs/README.md)
- [要件定義](docs/00_requirements.md)
- [機能仕様](docs/01_functional_spec.md)
- [音声処理仕様](docs/02_audio_engine_spec.md)
- [受け入れテスト計画](docs/03_acceptance_test_plan.md)
- [現状差分と未達リスト](docs/04_gap_analysis.md)
- [実音源受け入れテスト結果](docs/05_real_audio_test_report.md)

2026-05-05時点では、ユーザー提供の実音源5曲でWAV/MP3の精密仕上げ検査に合格しています。
