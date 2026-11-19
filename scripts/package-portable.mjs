import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const rootDir = process.cwd();
const distDir = path.join(rootDir, 'dist');
const assetsDir = path.join(distDir, 'assets');
const indexPath = path.join(distDir, 'index.html');
const battlefieldPath = path.join(distDir, 'battlefield.html');
const readmePath = path.join(distDir, 'README.txt');
const distTanksDir = path.join(distDir, 'tanks');
const workspaceTanksDir = path.join(rootDir, 'tanks');
const zipPath = path.join(rootDir, 'codepanzer-portable.zip');

if (!fs.existsSync(indexPath)) {
  throw new Error(`dist/index.html not found at ${indexPath}. Run npm run build first.`);
}

let html = fs.readFileSync(indexPath, 'utf8');
const assetFiles = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];

const cssFile = assetFiles.find((f) => f.endsWith('.css'));
const jsFile = assetFiles.find((f) => f.endsWith('.js'));

if (!jsFile) {
  throw new Error('Built JS asset not found in dist/assets');
}

if (cssFile) {
  const cssContent = fs.readFileSync(path.join(assetsDir, cssFile), 'utf8');
  const safeCss = cssContent.replace(/<\/style/gi, '<\\/style');
  const cssLinkRegex = new RegExp(
    `<link[^>]+href=["']\\.?\\/?assets\\/${cssFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`,
    'i'
  );
  if (cssLinkRegex.test(html)) {
    html = html.replace(cssLinkRegex, () => `<style>${safeCss}</style>`);
  } else {
    html = html.replace('</head>', () => `<style>${safeCss}</style>\n</head>`);
  }
}

const jsContent = fs.readFileSync(path.join(assetsDir, jsFile), 'utf8');
const safeJs = jsContent.replace(/<\/script/gi, '<\\/script');
const jsScriptRegex = new RegExp(
  `<script[^>]+src=["']\\.?\\/?assets\\/${jsFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>\\s*<\\/script>`,
  'i'
);

if (jsScriptRegex.test(html)) {
  // Move inline script to end of body so #root exists regardless of module/classic timing
  html = html.replace(jsScriptRegex, () => '');
  html = html.replace(
    '</body>',
    () => `<script type="module">${safeJs}</script>\n</body>`
  );
} else {
  throw new Error(`Could not locate script tag for ${jsFile} in dist/index.html`);
}

fs.writeFileSync(indexPath, html, 'utf8');

let battlefieldHtml = html.replace(/<html([^>]*)>/i, (_full, attrs) =>
  /data-app-mode/i.test(attrs) ? `<html${attrs}>` : `<html${attrs} data-app-mode="battlefield">`
);
battlefieldHtml = battlefieldHtml
  .replace(
    /<title>[^<]*<\/title>/i,
    '<title>CodePanzer.py - BATTLEFIELD | 大会・観戦アリーナ</title>'
  )
  .replace(/%2306b6d4/gi, '%23f59e0b')
  .replace(/%233b82f6/gi, '%23ef4444');
fs.writeFileSync(battlefieldPath, battlefieldHtml, 'utf8');

const readmeContent = `==================================================
  CodePanzer.py - Code Your Tank, Command the Arena. (配布用)
==================================================

■ 動作環境
  ・Windows / Mac 両対応
  ・Google Chrome / Microsoft Edge / Safari / Firefox などの Webブラウザ
  ※ Python や Node.js、追加ソフトのインストールは不要です。
  ※ インターネット接続がなくてもオフラインで動作します。

■ 起動方法
  1. この ZIP ファイルをフォルダに解凍（展開）してください。
  2. 用途に応じて解凍したフォルダ内のファイルを開いてください：
     ・index.html       … 課題学習・開発訓練・機体プログラミング画面
     ・battlefield.html … 複数機体読込・大会（バトロワ/チーム/トーナメント/リーグ）専用バトルフィールド画面
     （ダブルクリックすると自動的にブラウザが開き、ゲームが起動します）

■ 機体の保存と対戦相手の共有方法
  ・画面右上の「共有・読込」ボタン、またはエディタ・テストグラウンド上部の「読込」ボタンから操作できます。
  ・同梱フォルダ「tanks/」について：
    このフォルダには標準の自機・テストグラウンド用敵機データ（.vstank.json）が入っています。
    ご自身が作成した機体も同じ「tanks/」フォルダに保存しておくと、自機・対戦相手のどちらとしても
    1つのフォルダからまとめて開くことができます。
  ・作成した戦車の保存：
    「.vstank.json ファイル保存」または「自機をブラウザに保存」
  ・他人の戦車と戦う・中身を見る：
    「共有・読込」の機体ライブラリやテストグラウンドの「自機に読込」からプログラムを開けます。
    また、相手から受け取った「VST1-...」シェアコードを貼り付けるか、
    「.vstank.json」ファイルを画面へドラッグ＆ドロップしてください。

■ 謝辞 (Acknowledgments)
  本作は、プログラミング戦車バトルの先駆作「Robocode」および
  グリッドチップ型思考設計ゲームの名作「Carnage Heart（カルネージハート）」から
  多大な着想と影響を受けて制作されました。両作品に深い感謝と敬意を表します。
`;

fs.writeFileSync(readmePath, '\uFEFF' + readmeContent, 'utf8');

async function exportTankPresetFiles() {
  const esbuildBin = path.join(
    rootDir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild'
  );
  const presetsSrc = path.join(rootDir, 'src', 'data', 'presets.ts');
  const tmpBundle = path.join(os.tmpdir(), `codepanzer-presets-${process.pid}-${Date.now()}.mjs`);

  try {
    execFileSync(esbuildBin, [
      presetsSrc,
      '--bundle',
      '--format=esm',
      '--platform=node',
      `--outfile=${tmpBundle}`,
    ]);
    const mod = await import(pathToFileURL(tmpBundle).href);
    const list = [mod.DEFAULT_PLAYER_BLUEPRINT, ...(mod.PRESET_ENEMIES ?? [])].filter(Boolean);

    for (const dir of [distTanksDir, workspaceTanksDir]) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      list.forEach((bp, idx) => {
        const prefix = String(idx).padStart(2, '0');
        const safeName =
          String(bp.name || bp.id || 'tank')
            .replace(/[^\w\u3040-\u30ff\u4e00-\u9faf\uff10-\uff19-]+/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '') || 'tank';
        const gridSize = bp.program?.gridSize ?? 6;
        const fileName = `${prefix}_${safeName}_${gridSize}x${gridSize}.vstank.json`;
        fs.writeFileSync(path.join(dir, fileName), JSON.stringify(bp, null, 2), 'utf8');
      });
    }
    return list.length;
  } finally {
    if (fs.existsSync(tmpBundle)) {
      fs.unlinkSync(tmpBundle);
    }
  }
}

const exportedTankCount = await exportTankPresetFiles();

if (fs.existsSync(zipPath)) {
  fs.unlinkSync(zipPath);
}

execFileSync('zip', ['-r', zipPath, 'index.html', 'battlefield.html', 'README.txt', 'tanks'], {
  cwd: distDir,
  stdio: 'inherit',
});

const htmlSizeKb = (fs.statSync(indexPath).size / 1024).toFixed(1);
const bfSizeKb = (fs.statSync(battlefieldPath).size / 1024).toFixed(1);
const zipSizeKb = (fs.statSync(zipPath).size / 1024).toFixed(1);
console.log(`Portable index.html: ${htmlSizeKb} KB`);
console.log(`Portable battlefield.html: ${bfSizeKb} KB`);
console.log(`Exported ${exportedTankCount} tank files to tanks/ and dist/tanks/`);
console.log(`Created archive: ${zipPath} (${zipSizeKb} KB)`);
