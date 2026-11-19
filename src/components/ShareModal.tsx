import React, { useMemo, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  FolderOpen,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { cpuIdForGridSize } from '../data/parts';
import { PRESET_ENEMIES } from '../data/presets';
import { TankBlueprint } from '../types/game';
import {
  looksLikePythonSource,
  MAX_BATTLE_TANKS,
  parsePythonSourceWithAutoSize,
} from '../utils/codeParser';
import {
  decodeShareCode,
  deleteBlueprintFromStorage,
  encodeShareCode,
  exportTankJsonFile,
  loadSavedBlueprints,
  saveBlueprintToStorage,
  validateAndNormalizeBlueprint,
} from '../utils/share';

interface ShareModalProps {
  playerBlueprint: TankBlueprint;
  enemyBlueprint: TankBlueprint;
  onImportAsPlayer: (bp: TankBlueprint) => void;
  onImportAsEnemy: (bp: TankBlueprint) => void;
  onAddAsEnemy?: (bp: TankBlueprint) => void;
  canAddEnemy?: boolean;
  maxBattleTanks?: number;
  onClose: () => void;
}

export const ShareModal: React.FC<ShareModalProps> = ({
  playerBlueprint,
  enemyBlueprint,
  onImportAsPlayer,
  onImportAsEnemy,
  onAddAsEnemy,
  canAddEnemy = true,
  maxBattleTanks = MAX_BATTLE_TANKS,
  onClose,
}) => {
  const [shareTarget, setShareTarget] = useState<'player' | 'enemy'>('player');
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [savedList, setSavedList] = useState<TankBlueprint[]>(() => loadSavedBlueprints());
  const [libraryFilter, setLibraryFilter] = useState<'all' | 'saved' | 'preset'>('all');

  const cloneBp = (bp: TankBlueprint): TankBlueprint =>
    JSON.parse(JSON.stringify(bp)) as TankBlueprint;

  const activeBp = shareTarget === 'player' ? playerBlueprint : enemyBlueprint;

  const shareCode = useMemo(() => encodeShareCode(activeBp), [activeBp]);

  const handleCopy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1800);
    } catch {
      setImportError('クリップボードへのコピーに失敗しました。手動で選択してコピーしてください。');
    }
  };

  const handleImportCode = (dest: 'player' | 'enemy' | 'add_enemy') => {
    try {
      setImportError(null);
      const targetBase = dest === 'player' ? playerBlueprint : enemyBlueprint;
      if (looksLikePythonSource(importText)) {
        const parsed = parsePythonSourceWithAutoSize(
          importText,
          targetBase.program.gridSize,
          targetBase.program.coordinateMode
        );
        if (!parsed.ok) {
          setImportError(parsed.error);
          return;
        }
        const updatedBp: TankBlueprint = {
          ...targetBase,
          name: parsed.tankName ?? targetBase.name,
          assembly: {
            ...targetBase.assembly,
            cpu: cpuIdForGridSize(parsed.program.gridSize),
            chassis: parsed.chassisId ?? targetBase.assembly.chassis,
            radar: parsed.radarId ?? targetBase.assembly.radar,
            mainGun: parsed.mainGunId ?? targetBase.assembly.mainGun,
            subWeapon: parsed.subWeaponId ?? targetBase.assembly.subWeapon,
          },
          program: parsed.program,
        };
        if (dest === 'player') onImportAsPlayer(updatedBp);
        else if (dest === 'add_enemy' && onAddAsEnemy) onAddAsEnemy(updatedBp);
        else onImportAsEnemy(updatedBp);
        onClose();
        return;
      }

      const bp = decodeShareCode(importText);
      if (dest === 'player') {
        onImportAsPlayer(bp);
      } else if (dest === 'add_enemy' && onAddAsEnemy) {
        onAddAsEnemy(bp);
      } else {
        onImportAsEnemy(bp);
      }
      onClose();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : '読み込みに失敗しました');
    }
  };

  const parseFileToBlueprint = (text: string, baseBp: TankBlueprint): TankBlueprint => {
    const trimmed = text.trim();
    if (looksLikePythonSource(trimmed)) {
      const parsed = parsePythonSourceWithAutoSize(
        trimmed,
        baseBp.program.gridSize,
        baseBp.program.coordinateMode
      );
      if (!parsed.ok) {
        throw new Error(parsed.error);
      }
      return {
        ...baseBp,
        id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: parsed.tankName ?? baseBp.name,
        assembly: {
          ...baseBp.assembly,
          cpu: cpuIdForGridSize(parsed.program.gridSize),
          chassis: parsed.chassisId ?? baseBp.assembly.chassis,
          radar: parsed.radarId ?? baseBp.assembly.radar,
          mainGun: parsed.mainGunId ?? baseBp.assembly.mainGun,
          subWeapon: parsed.subWeaponId ?? baseBp.assembly.subWeapon,
        },
        program: parsed.program,
      };
    }
    return trimmed.startsWith('{')
      ? validateAndNormalizeBlueprint(JSON.parse(trimmed))
      : decodeShareCode(trimmed);
  };

  const handleFilesUpload = async (files: FileList, dest: 'player' | 'enemy' | 'add_enemy') => {
    try {
      setImportError(null);
      const fileArr = Array.from(files);
      for (let i = 0; i < fileArr.length; i++) {
        const text = await fileArr[i].text();
        const bp = parseFileToBlueprint(
          text,
          dest === 'player' ? playerBlueprint : enemyBlueprint
        );
        if (dest === 'player') {
          onImportAsPlayer(bp);
          break;
        } else if (dest === 'add_enemy' && onAddAsEnemy) {
          onAddAsEnemy(bp);
        } else {
          if (i === 0) onImportAsEnemy(bp);
          else if (onAddAsEnemy) onAddAsEnemy(bp);
        }
      }
      onClose();
    } catch (err) {
      setImportError(
        err instanceof Error ? err.message : 'ファイルの解析に失敗しました'
      );
    }
  };

  const handleSaveToBrowser = () => {
    const bpToSave: TankBlueprint = {
      ...playerBlueprint,
      id: playerBlueprint.id.startsWith('saved_')
        ? playerBlueprint.id
        : `saved_${Date.now()}`,
    };
    const updated = saveBlueprintToStorage(bpToSave);
    setSavedList(updated);
    onImportAsPlayer(bpToSave);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>プログラムの保存・共有 (インポート / エクスポート)</h3>
          <button type="button" className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-content share-layout">
          {/* Export Section */}
          <section className="share-card">
            <div className="share-card-head">
              <h4>エクスポート（書き出し・共有）</h4>
              <div className="seg-group">
                <button
                  type="button"
                  className={`seg-btn ${shareTarget === 'player' ? 'active' : ''}`}
                  onClick={() => setShareTarget('player')}
                >
                  自機 ({playerBlueprint.name})
                </button>
                <button
                  type="button"
                  className={`seg-btn ${shareTarget === 'enemy' ? 'active' : ''}`}
                  onClick={() => setShareTarget('enemy')}
                >
                  相手 ({enemyBlueprint.name})
                </button>
              </div>
            </div>

            <div className="share-field">
              <label>シェアコード (テキストでコピー・共有可能)</label>
              <div className="copy-row">
                <input type="text" readOnly value={shareCode} />
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => handleCopy(shareCode, 'code')}
                >
                  {copiedKey === 'code' ? <Check size={14} /> : <Copy size={14} />}
                  {copiedKey === 'code' ? 'コピー済' : 'コピー'}
                </button>
              </div>
            </div>

            <div className="share-actions">
              <button
                type="button"
                className="btn-primary"
                onClick={() => exportTankJsonFile(activeBp)}
              >
                <Download size={15} /> .vstank.json ファイル保存
              </button>
              <button type="button" className="btn-secondary" onClick={handleSaveToBrowser}>
                <Save size={15} /> 自機をブラウザに保存
              </button>
            </div>
          </section>

          {/* Import Section */}
          <section className="share-card">
            <h4>インポート（他人の機体・バックアップ読み込み）</h4>
            <div className="share-field">
              <label>
                シェアコード (VST1-...)・JSON・または Python ソースを貼り付け
              </label>
              <textarea
                rows={4}
                placeholder="VST1-... / JSON / Pythonソース (例: def on_tick(): ...)"
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
              />
              <div className="share-actions">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!importText.trim()}
                  onClick={() => handleImportCode('player')}
                >
                  自機として読み込む
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={!importText.trim()}
                  onClick={() => handleImportCode('enemy')}
                >
                  相手1に入替
                </button>
                {onAddAsEnemy && (
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={!importText.trim() || !canAddEnemy}
                    title={
                      canAddEnemy
                        ? `対戦相手として追加（合計${maxBattleTanks}台まで）`
                        : `最大${maxBattleTanks}台に達しています`
                    }
                    onClick={() => handleImportCode('add_enemy')}
                  >
                    + 相手に追加
                  </button>
                )}
              </div>
            </div>

            <div
              className="drop-zone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (e.dataTransfer.files.length > 0) {
                  handleFilesUpload(e.dataTransfer.files, onAddAsEnemy && canAddEnemy ? 'add_enemy' : 'enemy');
                }
              }}
            >
              <Upload size={18} />
              <span>
                .vstank.json / .py ファイルをドロップ（配布版の tanks/ フォルダ内ファイルも読込可・最大
                {maxBattleTanks}台対戦）
              </span>
              <div className="file-btn-row">
                <label className="mini-btn file-label">
                  自機として選択
                  <input
                    type="file"
                    accept=".json,.vstank.json,.py,.txt"
                    hidden
                    onChange={(e) => {
                      if (e.target.files && e.target.files.length > 0) {
                        handleFilesUpload(e.target.files, 'player');
                      }
                      e.target.value = '';
                    }}
                  />
                </label>
                <label className="mini-btn file-label">
                  相手として読込(複数可)
                  <input
                    type="file"
                    multiple
                    accept=".json,.vstank.json,.py,.txt"
                    hidden
                    onChange={(e) => {
                      if (e.target.files && e.target.files.length > 0) {
                        handleFilesUpload(e.target.files, onAddAsEnemy ? 'add_enemy' : 'enemy');
                      }
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
            </div>

            {importError && <div className="error-box">{importError}</div>}
          </section>

          {/* Unified Library: Browser Saved Slots + Test Ground Presets */}
          <section className="share-card share-card-full">
            <div className="library-header">
              <h4>
                <FolderOpen size={15} /> 機体ライブラリ（保存済み {savedList.length} ＋ 標準敵機 {PRESET_ENEMIES.length}）
              </h4>
              <div className="seg-group">
                <button
                  type="button"
                  className={`seg-btn ${libraryFilter === 'all' ? 'active' : ''}`}
                  onClick={() => setLibraryFilter('all')}
                >
                  すべて ({savedList.length + PRESET_ENEMIES.length})
                </button>
                <button
                  type="button"
                  className={`seg-btn ${libraryFilter === 'saved' ? 'active' : ''}`}
                  onClick={() => setLibraryFilter('saved')}
                >
                  保存済み ({savedList.length})
                </button>
                <button
                  type="button"
                  className={`seg-btn ${libraryFilter === 'preset' ? 'active' : ''}`}
                  onClick={() => setLibraryFilter('preset')}
                >
                  標準敵機 ({PRESET_ENEMIES.length})
                </button>
              </div>
            </div>

            {libraryFilter === 'saved' && savedList.length === 0 ? (
              <p className="muted-text">
                まだ保存された機体はありません。「自機をブラウザに保存」でローカル保存できます。
              </p>
            ) : (
              <div className="saved-grid">
                {(libraryFilter === 'all' || libraryFilter === 'saved') &&
                  savedList.map((bp) => (
                    <div key={`saved_${bp.id}`} className="saved-slot">
                      <div className="saved-info">
                        <span
                          className="color-dot"
                          style={{ backgroundColor: bp.color }}
                        />
                        <div>
                          <div className="saved-title-line">
                            <strong>{bp.name}</strong>
                            <span className="library-badge badge-saved">保存済</span>
                          </div>
                          <small>
                            {bp.program.gridSize}×{bp.program.gridSize} /{' '}
                            {bp.program.coordinateMode === 'relative' ? '相対座標' : '絶対座標'}
                          </small>
                        </div>
                      </div>
                      <div className="saved-btns">
                        <button
                          type="button"
                          className="mini-btn"
                          onClick={() => {
                            onImportAsPlayer(cloneBp(bp));
                            onClose();
                          }}
                        >
                          自機へ
                        </button>
                        <button
                          type="button"
                          className="mini-btn"
                          onClick={() => {
                            onImportAsEnemy(cloneBp(bp));
                            onClose();
                          }}
                        >
                          相手1へ
                        </button>
                        {onAddAsEnemy && (
                          <button
                            type="button"
                            className="mini-btn"
                            disabled={!canAddEnemy}
                            title={canAddEnemy ? '対戦相手に追加' : `最大${maxBattleTanks}台に達しています`}
                            onClick={() => {
                              onAddAsEnemy(cloneBp(bp));
                              onClose();
                            }}
                          >
                            +追加
                          </button>
                        )}
                        <button
                          type="button"
                          className="mini-btn"
                          title=".vstank.json ファイルとして保存"
                          onClick={() => exportTankJsonFile(bp)}
                        >
                          .json
                        </button>
                        <button
                          type="button"
                          className="icon-btn-danger"
                          onClick={() => setSavedList(deleteBlueprintFromStorage(bp.id))}
                          title="削除"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  ))}

                {(libraryFilter === 'all' || libraryFilter === 'preset') &&
                  PRESET_ENEMIES.map((bp) => (
                    <div key={`preset_${bp.id}`} className="saved-slot">
                      <div className="saved-info">
                        <span
                          className="color-dot"
                          style={{ backgroundColor: bp.color }}
                        />
                        <div>
                          <div className="saved-title-line">
                            <strong>{bp.name}</strong>
                            <span className="library-badge badge-preset">標準敵機</span>
                          </div>
                          <small>
                            {bp.program.gridSize}×{bp.program.gridSize} /{' '}
                            {bp.assembly.chassis} / {bp.assembly.mainGun}
                          </small>
                        </div>
                      </div>
                      <div className="saved-btns">
                        <button
                          type="button"
                          className="mini-btn"
                          title="この敵機のプログラムを自機に読み込んで確認・改造する"
                          onClick={() => {
                            onImportAsPlayer(cloneBp(bp));
                            onClose();
                          }}
                        >
                          自機へ
                        </button>
                        <button
                          type="button"
                          className="mini-btn"
                          onClick={() => {
                            onImportAsEnemy(cloneBp(bp));
                            onClose();
                          }}
                        >
                          相手1へ
                        </button>
                        {onAddAsEnemy && (
                          <button
                            type="button"
                            className="mini-btn"
                            disabled={!canAddEnemy}
                            title={canAddEnemy ? '対戦相手に追加' : `最大${maxBattleTanks}台に達しています`}
                            onClick={() => {
                              onAddAsEnemy(cloneBp(bp));
                              onClose();
                            }}
                          >
                            +追加
                          </button>
                        )}
                        <button
                          type="button"
                          className="mini-btn"
                          title=".vstank.json ファイルとして保存"
                          onClick={() => exportTankJsonFile(bp)}
                        >
                          .json
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};

