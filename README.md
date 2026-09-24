# TRPG Timeline

TRPGのシナリオを、時系列・関連性・検索条件を見ながら整理・編集するためのブラウザアプリです。

- 年/月単位でシナリオを配置
- Same / After / 関連の接続線を描画
- タグ管理と詳細検索
- JSON保存 / JSON読込
- HTML出力で単体ページとして保存
- GitHub Pages で公開して閲覧可能

## これは何のアプリか

このアプリは、TRPGの世界観・イベント・登場人物・タグなどを時間軸で整理するための補助ツールです。

- シナリオを一覧として管理
- 発生順と因果関係を把握
- 重要イベントや伏線の見直しがしやすい
- 関連シナリオの確認や共有用ページの出力が可能

---

## GitHub Pages で公開する方法

このアプリは HTML / CSS / JavaScript の静的サイトです。GitHub Pages にアップロードして、ブラウザで閲覧できます。

### 前提条件

- GitHub にリポジトリを作成済みであること
- リポジトリ直下に以下のファイルがあること
  - [index.html](index.html)
  - [styles.css](styles.css)
  - [app.js](app.js)
- GitHub Pages で静的サイトを公開できる設定があること

### 公開手順

1. GitHub のリポジトリにコードを push する
2. GitHub のリポジトリ画面で「Settings」→「Pages」を開く
3. 「Source」を「Deploy from a branch」に変更
4. Branch を `main` または `master`、Folder を `/(root)` に設定
5. 保存すると、GitHub Pages の URL が発行される

公開後のURLの形式は次のようになります。

```text
https://<ユーザー名>.github.io/<リポジトリ名>/
```

例:

```text
https://example.github.io/TRPG_TimeLine/
```

> このアプリはサーバーサイド処理を使わないため、GitHub Pages でそのまま閲覧可能です。

---

## ローカルでの起動方法

### ローカルWebサーバーで開く

ES Modulesを使用しているため、ローカルWebサーバー経由で開いてください。

```bash
cd "c:\Users\hakue\source\repos\TRPG_TimeLine"
python -m http.server 8000
```

その後、ブラウザで次のURLを開いてください。

```text
http://localhost:8000/
```

> 直接開いても動作しますが、ローカルサーバー経由の方が安定します。

---

## 基本操作

### 1. シナリオの追加

画面上部の「シナリオ追加」ボタンを押します。

- 左側の一覧から対象を選択
- 右側の詳細パネルで内容を編集
- タイトル、サマリー、GM、PC/NPC、タグ、年/月を入力

### 2. タグの管理

「タグ管理」ボタンを押すと、タグ一覧を編集できます。

- タグの追加
- タグの削除
- 色の設定
- 既存タグの再利用

検索時はタグをカンマ区切りで入力するか、チップをクリックして絞り込みできます。

### 3. 検索とフィルター

画面上部の検索欄で、次の条件で絞り込みができます。

- キーワード
- タイトル
- サマリー
- GM
- PC/NPC名
- タグ
- 年/月

「詳細」ボタンを押すと、より細かい条件を入力できます。

### 4. タイムライン編集

シナリオカードは年/月ごとに配置され、関連するカード同士に接続線が引かれます。

- 同じ月内の関係
- 前後の因果関係
- 関連するカードの視覚的な整理

編集画面では、詳細情報やタグ、関係性を管理していく流れが使いやすいように作られています。

### 5. JSON保存 / JSON読込

画面上部のボタンを使ってデータを管理できます。

- 「JSON保存」: 現在のデータをJSON形式で保存
- 「JSON読込」: 以前に保存したJSONを再読込

データをバックアップしたり、別の編集作業に再利用したりできます。

### 6. HTML出力

「HTML出力」ボタンを押すと、現在のタイムラインを単体のHTMLとして書き出せます。

- ブラウザでそのまま開ける
- 共有用の閲覧ページとして使える
- 接続線やカードレイアウトを再現できる

---

## アプリを更新したあとに反映する方法

このアプリは GitHub Pages へ push した内容がそのまま公開対象になるため、更新作業は次の流れで行います。

```bash
git add .
git commit -m "機能追加または修正内容"
git push origin main
```

### 反映の流れ

1. ローカルで修正を行う
2. 必要に応じてローカルで動作確認する
3. `git add .` で変更をステージングする
4. `git commit -m "..."` でコミットする
5. `git push origin main` で GitHub に反映する
6. GitHub の Pages 設定を確認し、数分以内に URL で更新内容が見える

### 確認ポイント

- GitHub の Pages が `main` / `root` で公開されているか
- 変更ファイルがリポジトリに push されているか
- ブラウザで公開 URL を開いて更新が反映されているか

> 更新内容の見え方は GitHub Pages の反映待ち時間があるため、数十秒〜数分程度かかることがあります。

---

## 主要ファイル

- [index.html](index.html): アプリの画面構成
- [styles.css](styles.css): レイアウトと見た目
- [app.js](app.js): アプリの起動、描画、編集、HTML出力の調整
- [js/state.js](js/state.js): アプリ状態とDOM参照
- [js/scenario-data.js](js/scenario-data.js): シナリオ、タグ、参加者データの正規化
- [js/filters.js](js/filters.js): 検索とフィルター
- [js/timeline-layout.js](js/timeline-layout.js): 月単位のタイムライン配置補助
- [js/connections.js](js/connections.js): 接続線のペア識別・端点補助
- [js/renderer.js](js/renderer.js): 描画用の選択処理
- [js/modals.js](js/modals.js): モーダル入力値の補助
- [js/persistence.js](js/persistence.js): JSON保存用データとファイルダウンロード
- [README.md](README.md): 使用方法と公開・更新手順

### 接続線テスト

ブラウザで [tests/connection-routing.html](tests/connection-routing.html) を開くと、接続線ルールのテストを実行できます。

Node.jsが利用できる環境では、次のコマンドでもテストできます。

```bash
node --test tests/connection-routing.test.js
```

---

## 使い方の流れ

1. シナリオを追加する
2. タイトルと概要を入力する
3. タグを設定する
4. 年/月と関連性を整理する
5. 検索で必要なシナリオを絞り込む
6. JSON保存またはHTML出力で成果物化する
7. GitHub Pages で公開して閲覧・共有する

---

## 注意点

- アプリは初期状態で空の状態から始まります
- まずシナリオを作ってから編集を進める前提です
- HTML出力やJSON保存はブラウザのダウンロード機能を利用します
- GitHub Pages の公開は静的ファイルのみ対応です
- バックエンドやDBは使わない前提で設計されています

---

## まとめ

このツールは、TRPGのシナリオ展開を「一覧」「時系列」「関連性」で一度に見るための補助ツールとして使えます。

個人用のシナリオ管理から、セッション準備、設計書の整理、共有用の閲覧ページ作成まで幅広く活用できます。GitHub Pages に公開すれば、ローカル環境だけでなくブラウザで簡単に閲覧・共有できます。