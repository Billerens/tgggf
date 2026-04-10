import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  buildBackupPayload,
  createBackupVersionTag,
  exportBackupFile,
  importBackupPayload,
  parseBackupFile,
  type BackupImportMode,
} from "./dataTransfer";
import {
  authorizeGoogleDrive,
  DEFAULT_EXPORTS_FOLDER_NAME,
  downloadGoogleDriveFileBlob,
  ensureGoogleDriveExportsFolder,
  fetchGoogleAccountEmail,
  listBackupsInGoogleDrive,
  uploadBackupBlobToGoogleDrive,
  type GoogleDriveFileMeta,
} from "./googleDriveSync";
import type { AppSettings } from "../../types";

interface GoogleDriveAuthState {
  accessToken: string;
  expiresAt: number;
  email: string;
}

interface UseGoogleDriveBackupSyncParams {
  settingsDraft: AppSettings;
  setSettingsDraft: Dispatch<SetStateAction<AppSettings>>;
  saveSettings: (settings: AppSettings) => Promise<void>;
  initialize: () => Promise<void>;
  isSettingsOpen: boolean;
  setDataTransferMessage: (message: string | null) => void;
  onError: (message: string) => void;
}

interface RefreshBackupsOptions {
  interactive: boolean;
}

export function useGoogleDriveBackupSync({
  settingsDraft,
  setSettingsDraft,
  saveSettings,
  initialize,
  isSettingsOpen,
  setDataTransferMessage,
  onError,
}: UseGoogleDriveBackupSyncParams) {
  const [driveBusy, setDriveBusy] = useState(false);
  const [googleDriveAuth, setGoogleDriveAuth] = useState<GoogleDriveAuthState | null>(
    null,
  );
  const [googleDriveBackups, setGoogleDriveBackups] = useState<GoogleDriveFileMeta[]>(
    [],
  );
  const [selectedGoogleDriveBackupId, setSelectedGoogleDriveBackupId] = useState("");
  const [driveBackupName, setDriveBackupName] = useState("");

  const configuredGoogleDriveClientId = useMemo(
    () =>
      (
        settingsDraft.googleDriveClientId.trim() ||
        String(import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID || "").trim()
      ).trim(),
    [settingsDraft.googleDriveClientId],
  );
  const googleDriveConfigured = Boolean(configuredGoogleDriveClientId);

  const persistGoogleDriveFolderId = useCallback(
    async (nextFolderId: string) => {
      const normalizedFolderId = nextFolderId.trim();
      const nextSettings = {
        ...settingsDraft,
        googleDriveClientId: settingsDraft.googleDriveClientId.trim(),
        googleDriveFolderId: normalizedFolderId,
      };
      setSettingsDraft(nextSettings);
      await saveSettings(nextSettings);
      return nextSettings;
    },
    [saveSettings, setSettingsDraft, settingsDraft],
  );

  const ensureGoogleDriveAccessToken = useCallback(
    async (interactive: boolean) => {
      const clientId = configuredGoogleDriveClientId;
      if (!clientId) {
        throw new Error("Google Drive OAuth Client ID не настроен в приложении.");
      }

      if (googleDriveAuth && googleDriveAuth.expiresAt - 60_000 > Date.now()) {
        return {
          accessToken: googleDriveAuth.accessToken,
          email: googleDriveAuth.email,
        };
      }

      const tokenInfo = await authorizeGoogleDrive(
        clientId,
        interactive ? "consent" : "none",
      );

      let email = googleDriveAuth?.email || "";
      try {
        const fetchedEmail = await fetchGoogleAccountEmail(tokenInfo.accessToken);
        if (fetchedEmail) {
          email = fetchedEmail;
        }
      } catch {
        // userinfo endpoint не обязателен для синхронизации.
      }

      setGoogleDriveAuth({
        accessToken: tokenInfo.accessToken,
        expiresAt: tokenInfo.expiresAt,
        email,
      });

      return {
        accessToken: tokenInfo.accessToken,
        email,
      };
    },
    [configuredGoogleDriveClientId, googleDriveAuth],
  );

  const ensureGoogleDriveFolderId = useCallback(
    async (accessToken: string) => {
      const resolvedFolderId = await ensureGoogleDriveExportsFolder(
        accessToken,
        settingsDraft.googleDriveFolderId.trim(),
        DEFAULT_EXPORTS_FOLDER_NAME,
      );
      if (resolvedFolderId !== settingsDraft.googleDriveFolderId.trim()) {
        await persistGoogleDriveFolderId(resolvedFolderId);
      }
      return resolvedFolderId;
    },
    [persistGoogleDriveFolderId, settingsDraft.googleDriveFolderId],
  );

  const refreshGoogleDriveBackups = useCallback(
    async ({ interactive }: RefreshBackupsOptions) => {
      const auth = await ensureGoogleDriveAccessToken(interactive);
      const folderId = await ensureGoogleDriveFolderId(auth.accessToken);
      const backups = await listBackupsInGoogleDrive(auth.accessToken, folderId, 50);

      setGoogleDriveBackups(backups);
      setSelectedGoogleDriveBackupId((currentId) => {
        if (currentId && backups.some((item) => item.id === currentId)) {
          return currentId;
        }
        return backups[0]?.id ?? "";
      });

      return {
        auth,
        folderId,
        backups,
      };
    },
    [ensureGoogleDriveAccessToken, ensureGoogleDriveFolderId],
  );

  const onGoogleDriveConnect = useCallback(async () => {
    setDriveBusy(true);
    setDataTransferMessage(null);
    try {
      const { auth, folderId, backups } = await refreshGoogleDriveBackups({
        interactive: true,
      });
      const accountEmail = (auth.email || "").trim();
      setDataTransferMessage(
        [
          "Google Drive подключен.",
          accountEmail ? `Аккаунт: ${accountEmail}` : "Аккаунт: авторизован",
          `Папка синхронизации: ${folderId}`,
          `Найдено бэкапов: ${backups.length}`,
        ].join("\n"),
      );
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setDriveBusy(false);
    }
  }, [onError, refreshGoogleDriveBackups, setDataTransferMessage]);

  const onGoogleDriveDisconnect = useCallback(() => {
    setGoogleDriveAuth(null);
    setGoogleDriveBackups([]);
    setSelectedGoogleDriveBackupId("");
    setDataTransferMessage("Google Drive отключен для текущей сессии.");
  }, [setDataTransferMessage]);

  const onGoogleDriveRefreshBackups = useCallback(async () => {
    setDriveBusy(true);
    setDataTransferMessage(null);
    try {
      const { backups } = await refreshGoogleDriveBackups({ interactive: true });
      setDataTransferMessage(`Список бэкапов обновлен. Найдено: ${backups.length}.`);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setDriveBusy(false);
    }
  }, [onError, refreshGoogleDriveBackups, setDataTransferMessage]);

  const onGoogleDriveSyncUpload = useCallback(async () => {
    setDriveBusy(true);
    setDataTransferMessage(null);
    try {
      const auth = await ensureGoogleDriveAccessToken(true);
      const folderId = await ensureGoogleDriveFolderId(auth.accessToken);

      const payload = await buildBackupPayload({ scope: "all" });
      const versionTag = createBackupVersionTag();
      const backupLabel = driveBackupName.trim();
      const preparedFile = await exportBackupFile(payload, "zip", {
        backupName: backupLabel,
        versionTag,
      });
      const uploaded = await uploadBackupBlobToGoogleDrive(auth.accessToken, {
        folderId,
        fileName: preparedFile.fileName,
        blob: preparedFile.blob,
        mimeType: preparedFile.blob.type || "application/zip",
        versionTag,
        backupLabel,
        exportScope: payload.exportScope,
        exportedAt: payload.exportedAt,
      });

      const backups = await listBackupsInGoogleDrive(auth.accessToken, folderId, 50);
      setGoogleDriveBackups(backups);
      setSelectedGoogleDriveBackupId(uploaded.id);

      setDataTransferMessage(
        [
          "Синхронизация в Google Drive завершена.",
          `Файл: ${uploaded.name}`,
          uploaded.versionTag ? `Версия: ${uploaded.versionTag}` : "",
          uploaded.backupLabel ? `Название: ${uploaded.backupLabel}` : "",
          `ID: ${uploaded.id}`,
          `personas=${payload.meta.personas}, chats=${payload.meta.chats}, messages=${payload.meta.messages}, imageAssets=${payload.meta.imageAssets}, groupRooms=${payload.meta.groupRooms}`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setDriveBusy(false);
    }
  }, [
    driveBackupName,
    ensureGoogleDriveAccessToken,
    ensureGoogleDriveFolderId,
    onError,
    setDataTransferMessage,
  ]);

  const onGoogleDriveSyncDownload = useCallback(
    async (mode: BackupImportMode) => {
      setDriveBusy(true);
      setDataTransferMessage(null);
      try {
        const auth = await ensureGoogleDriveAccessToken(true);
        const folderId = await ensureGoogleDriveFolderId(auth.accessToken);
        let backups = googleDriveBackups;
        if (backups.length === 0) {
          backups = await listBackupsInGoogleDrive(auth.accessToken, folderId, 50);
          setGoogleDriveBackups(backups);
        }
        if (!backups.length) {
          setDataTransferMessage(
            "В папке Google Drive пока нет экспортов приложения для восстановления.",
          );
          return;
        }

        const selectedId = selectedGoogleDriveBackupId.trim();
        const targetBackup = selectedId
          ? backups.find((item) => item.id === selectedId)
          : backups[0];
        if (!targetBackup?.id) {
          throw new Error(
            "Выбранный бэкап не найден. Обнови список версий и выбери доступную.",
          );
        }

        const remoteBlob = await downloadGoogleDriveFileBlob(
          auth.accessToken,
          targetBackup.id,
        );
        const importedFile = new File([remoteBlob], targetBackup.name || "backup.zip", {
          type: remoteBlob.type || "application/zip",
        });
        const payload = await parseBackupFile(importedFile);
        const meta = await importBackupPayload(payload, mode);
        await initialize();
        setSelectedGoogleDriveBackupId(targetBackup.id);
        setDataTransferMessage(
          [
            `Восстановление из Google Drive выполнено: ${targetBackup.name}`,
            targetBackup.versionTag ? `Версия: ${targetBackup.versionTag}` : "",
            targetBackup.backupLabel ? `Название: ${targetBackup.backupLabel}` : "",
            `Режим: ${mode === "replace" ? "замена текущих данных" : "добавление/объединение"}`,
            `personas=${meta.personas}, chats=${meta.chats}, messages=${meta.messages}, states=${meta.personaStates}, memories=${meta.memories}, sessions=${meta.generatorSessions}, imageAssets=${meta.imageAssets}, groupRooms=${meta.groupRooms}, groupMessages=${meta.groupMessages}, groupEvents=${meta.groupEvents}`,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      } catch (error) {
        onError((error as Error).message);
      } finally {
        setDriveBusy(false);
      }
    },
    [
      ensureGoogleDriveAccessToken,
      ensureGoogleDriveFolderId,
      googleDriveBackups,
      initialize,
      onError,
      selectedGoogleDriveBackupId,
      setDataTransferMessage,
    ],
  );

  useEffect(() => {
    if (!isSettingsOpen || !googleDriveAuth) return;
    void refreshGoogleDriveBackups({ interactive: false }).catch(() => {
      // Тихо игнорируем ошибки фонового обновления списка.
    });
  }, [googleDriveAuth, isSettingsOpen, refreshGoogleDriveBackups]);

  return {
    driveBusy,
    googleDriveConfigured,
    googleDriveConnected: Boolean(googleDriveAuth),
    googleDriveAccountEmail: googleDriveAuth?.email || null,
    googleDriveBackups,
    selectedGoogleDriveBackupId,
    setSelectedGoogleDriveBackupId,
    driveBackupName,
    setDriveBackupName,
    onGoogleDriveConnect,
    onGoogleDriveDisconnect,
    onGoogleDriveRefreshBackups,
    onGoogleDriveSyncUpload,
    onGoogleDriveSyncDownload,
  };
}
