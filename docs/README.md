# Suno Mastering Bench 仕様ドキュメント

このディレクトリは、Sunoなどで作った音源を「直感的に触りながら、WAVマスターとして保存できる」ローカルWebアプリの要件と仕様を固定する場所です。

現時点の狙いは、プロのマスタリングエンジニアを完全代替することではありません。音楽知識が少なくても、Before/Afterを耳で比べながら安全に音を整え、ffmpegの精密仕上げでLUFS/True Peakを確認したWAVを書き出せる実用ベータです。

## 読む順番

1. [00_requirements.md](00_requirements.md)  
   プロダクト要件、対象ユーザー、成功条件、非目標。
2. [01_functional_spec.md](01_functional_spec.md)  
   画面、操作、状態管理、読み込み、比較、書き出しの機能仕様。
3. [02_audio_engine_spec.md](02_audio_engine_spec.md)  
   基本補正、直感スライダー、リミッター、精密解析、測定責任範囲。
4. [03_acceptance_test_plan.md](03_acceptance_test_plan.md)  
   「使える」と判断するための受け入れテスト。
5. [04_gap_analysis.md](04_gap_analysis.md)  
   現状差分、解消済み項目、残る未達。
6. [05_real_audio_test_report.md](05_real_audio_test_report.md)  
   実音源5曲での機械検査結果。

## 現在のリリース判定

2026-05-05時点では、P0の未達はありません。WAVマスター書き出し、MP3コピー、ffmpeg精密仕上げ、古いAfterの誤書き出し防止、実音源5曲の機械検査は完了しています。

残る主な確認は、実際に耳で聴いたときのプリセット値と効き方の調整です。これはユーザーの好みと曲ごとの意図に関わるため、機械検査だけでは完了扱いにしません。
