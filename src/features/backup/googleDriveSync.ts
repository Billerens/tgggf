const GOOGLE_IDENTITY_SCRIPT_SRC = "https://accounts.google.com/gsi/client";
const GOOGLE_USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";
const DRIVE_FILES_ENDPOINT = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/drive/v3/files";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
const GOOGLE_OAUTH_SCOPE = `${DRIVE_SCOPE} ${EMAIL_SCOPE}`;
const DEFAULT_EXPORTS_FOLDER_NAME = "TG-GF Exports";
const APP_PROPERTY_SOURCE_KEY = "sourceApp";
const APP_PROPERTY_SOURCE_VALUE = "tg-gf";
const APP_PROPERTY_KIND_KEY = "kind";
const APP_PROPERTY_KIND_VALUE = "backup";
const APP_PROPERTY_VERSION_KEY = "version";
const APP_PROPERTY_LABEL_KEY = "label";
const APP_PROPERTY_SCOPE_KEY = "scope";
const APP_PROPERTY_EXPORTED_AT_KEY = "exportedAt";

interface GoogleTokenResponse {
  access_token: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface GoogleTokenClient {
  callback: (response: GoogleTokenResponse) => void;
  requestAccessToken: (options?: { prompt?: string }) => void;
}

interface GoogleTokenClientError {
  type?: string;
  message?: string;
}

interface GoogleOauth2Api {
  initTokenClient: (config: {
    client_id: string;
    scope: string;
    callback: (response: GoogleTokenResponse) => void;
    error_callback?: (error: GoogleTokenClientError) => void;
  }) => GoogleTokenClient;
}

interface GoogleIdentityApi {
  accounts: {
    oauth2: GoogleOauth2Api;
  };
}

interface DriveFileEntry {
  id: string;
  name: string;
  mimeType?: string;
  modifiedTime?: string;
  size?: string;
  appProperties?: Record<string, string>;
}

interface DriveFileListResponse {
  files?: DriveFileEntry[];
  nextPageToken?: string;
}

export interface GoogleDriveTokenInfo {
  accessToken: string;
  expiresAt: number;
}

export interface GoogleDriveFileMeta {
  id: string;
  name: string;
  mimeType?: string;
  modifiedTime?: string;
  size?: string;
  versionTag?: string;
  backupLabel?: string;
  exportScope?: string;
  exportedAt?: string;
}

let scriptLoadPromise: Promise<void> | null = null;

function getGoogleIdentityApi() {
  return (window as Window & { google?: GoogleIdentityApi }).google;
}

function escapeDriveQueryValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function buildBackupFilesQuery(folderId: string) {
  return (
    `'${escapeDriveQueryValue(folderId)}' in parents and ` +
    "trashed=false and " +
    `appProperties has { key='${APP_PROPERTY_SOURCE_KEY}' and value='${APP_PROPERTY_SOURCE_VALUE}' } and ` +
    `appProperties has { key='${APP_PROPERTY_KIND_KEY}' and value='${APP_PROPERTY_KIND_VALUE}' }`
  );
}

function inferVersionTagFromFileName(fileName: string) {
  const match = fileName.match(/-v([0-9A-Za-z_-]+)/);
  return match?.[1] || "";
}

function mapDriveFileEntryToMeta(entry: DriveFileEntry): GoogleDriveFileMeta {
  const appProperties = entry.appProperties ?? {};
  const versionTag =
    (appProperties[APP_PROPERTY_VERSION_KEY] || "").trim() ||
    inferVersionTagFromFileName(entry.name || "");
  return {
    id: entry.id,
    name: entry.name || "backup.zip",
    mimeType: entry.mimeType,
    modifiedTime: entry.modifiedTime,
    size: entry.size,
    versionTag,
    backupLabel: (appProperties[APP_PROPERTY_LABEL_KEY] || "").trim(),
    exportScope: (appProperties[APP_PROPERTY_SCOPE_KEY] || "").trim(),
    exportedAt: (appProperties[APP_PROPERTY_EXPORTED_AT_KEY] || "").trim(),
  };
}

async function ensureGoogleIdentityScriptLoaded() {
  const existingApi = getGoogleIdentityApi();
  if (existingApi?.accounts?.oauth2) {
    return;
  }
  if (!scriptLoadPromise) {
    scriptLoadPromise = new Promise<void>((resolve, reject) => {
      const existingScript = document.querySelector<HTMLScriptElement>(
        `script[src="${GOOGLE_IDENTITY_SCRIPT_SRC}"]`,
      );
      if (existingScript) {
        existingScript.addEventListener("load", () => resolve(), {
          once: true,
        });
        existingScript.addEventListener(
          "error",
          () => reject(new Error("Не удалось загрузить Google Identity script.")),
          { once: true },
        );
        return;
      }

      const script = document.createElement("script");
      script.src = GOOGLE_IDENTITY_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () =>
        reject(new Error("Не удалось загрузить Google Identity script."));
      document.head.appendChild(script);
    });
  }
  await scriptLoadPromise;
  const api = getGoogleIdentityApi();
  if (!api?.accounts?.oauth2) {
    throw new Error("Google Identity API недоступно после загрузки скрипта.");
  }
}

async function requestGoogleToken(clientId: string, prompt: "consent" | "none") {
  await ensureGoogleIdentityScriptLoaded();
  const api = getGoogleIdentityApi();
  if (!api?.accounts?.oauth2) {
    throw new Error("Google OAuth API недоступно.");
  }

  return await new Promise<GoogleTokenResponse>((resolve, reject) => {
    try {
      let completed = false;
      const finishWithError = (error: Error) => {
        if (completed) return;
        completed = true;
        reject(error);
      };
      const finishWithSuccess = (response: GoogleTokenResponse) => {
        if (completed) return;
        completed = true;
        resolve(response);
      };

      const tokenClient = api.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: GOOGLE_OAUTH_SCOPE,
        callback: (response) => {
          if (response.error) {
            const description =
              response.error_description || "Неизвестная ошибка авторизации.";
            finishWithError(
              new Error(`Google OAuth: ${response.error} (${description})`),
            );
            return;
          }
          if (!response.access_token) {
            finishWithError(new Error("Google OAuth не вернул access_token."));
            return;
          }
          finishWithSuccess(response);
        },
        error_callback: (error) => {
          const normalizedType = (error?.type || "").trim();
          if (!normalizedType) {
            finishWithError(
              new Error(
                `Google OAuth popup error: ${error?.message || "Неизвестная ошибка окна авторизации."}`,
              ),
            );
            return;
          }
          finishWithError(
            new Error(
              `Google OAuth popup error: ${normalizedType}${error?.message ? ` (${error.message})` : ""}`,
            ),
          );
        },
      });
      tokenClient.requestAccessToken({ prompt });
    } catch (error) {
      reject(error);
    }
  });
}

async function driveRequestJson<T>(
  accessToken: string,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(
      `Google Drive API error (${response.status}): ${bodyText || response.statusText}`,
    );
  }

  return (await response.json()) as T;
}

async function driveRequestBlob(
  accessToken: string,
  url: string,
  init?: RequestInit,
): Promise<Blob> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(
      `Google Drive API error (${response.status}): ${bodyText || response.statusText}`,
    );
  }

  return await response.blob();
}

export async function authorizeGoogleDrive(
  clientId: string,
  prompt: "consent" | "none" = "consent",
): Promise<GoogleDriveTokenInfo> {
  const normalizedClientId = clientId.trim();
  if (!normalizedClientId) {
    throw new Error("Google OAuth Client ID не указан.");
  }

  const token = await requestGoogleToken(normalizedClientId, prompt);
  const ttlSeconds =
    typeof token.expires_in === "number" && Number.isFinite(token.expires_in)
      ? Math.max(30, token.expires_in)
      : 3600;

  return {
    accessToken: token.access_token,
    expiresAt: Date.now() + ttlSeconds * 1000,
  };
}

export async function fetchGoogleAccountEmail(accessToken: string) {
  const user = await driveRequestJson<{ email?: string }>(
    accessToken,
    GOOGLE_USERINFO_ENDPOINT,
  );
  return (user.email || "").trim();
}

export async function ensureGoogleDriveExportsFolder(
  accessToken: string,
  configuredFolderId?: string,
  folderName = DEFAULT_EXPORTS_FOLDER_NAME,
) {
  const normalizedConfiguredId = (configuredFolderId || "").trim();
  if (normalizedConfiguredId) {
    const meta = await driveRequestJson<DriveFileEntry>(
      accessToken,
      `${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(
        normalizedConfiguredId,
      )}?fields=id,name,mimeType`,
    );
    if (meta.mimeType !== "application/vnd.google-apps.folder") {
      throw new Error("Указанный Google Drive Folder ID не является папкой.");
    }
    return meta.id;
  }

  const escapedFolderName = escapeDriveQueryValue(folderName);
  const folderQuery =
    `mimeType='application/vnd.google-apps.folder' and ` +
    `name='${escapedFolderName}' and trashed=false`;
  const searchResult = await driveRequestJson<DriveFileListResponse>(
    accessToken,
    `${DRIVE_FILES_ENDPOINT}?q=${encodeURIComponent(
      folderQuery,
    )}&fields=files(id,name,mimeType)&pageSize=10`,
  );
  const existingFolder = (searchResult.files ?? [])[0];
  if (existingFolder?.id) {
    return existingFolder.id;
  }

  const createdFolder = await driveRequestJson<DriveFileEntry>(
    accessToken,
    `${DRIVE_FILES_ENDPOINT}?fields=id,name,mimeType`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
      }),
    },
  );
  if (!createdFolder.id) {
    throw new Error("Не удалось создать папку экспорта в Google Drive.");
  }
  return createdFolder.id;
}

export async function uploadBackupBlobToGoogleDrive(
  accessToken: string,
  params: {
    folderId: string;
    fileName: string;
    blob: Blob;
    mimeType?: string;
    versionTag?: string;
    backupLabel?: string;
    exportScope?: string;
    exportedAt?: string;
  },
): Promise<GoogleDriveFileMeta> {
  const folderId = params.folderId.trim();
  if (!folderId) {
    throw new Error("Не указан folderId для загрузки в Google Drive.");
  }
  const fileName = params.fileName.trim();
  if (!fileName) {
    throw new Error("Не указано имя файла для загрузки в Google Drive.");
  }

  const mimeType = (params.mimeType || params.blob.type || "application/octet-stream").trim();
  const boundary = `tg-gf-${crypto.randomUUID()}`;
  const appProperties: Record<string, string> = {
    [APP_PROPERTY_SOURCE_KEY]: APP_PROPERTY_SOURCE_VALUE,
    [APP_PROPERTY_KIND_KEY]: APP_PROPERTY_KIND_VALUE,
  };
  const normalizedVersionTag = (params.versionTag || "").trim();
  const normalizedBackupLabel = (params.backupLabel || "").trim();
  const normalizedExportScope = (params.exportScope || "").trim();
  const normalizedExportedAt = (params.exportedAt || "").trim();
  if (normalizedVersionTag) {
    appProperties[APP_PROPERTY_VERSION_KEY] = normalizedVersionTag;
  }
  if (normalizedBackupLabel) {
    appProperties[APP_PROPERTY_LABEL_KEY] = normalizedBackupLabel;
  }
  if (normalizedExportScope) {
    appProperties[APP_PROPERTY_SCOPE_KEY] = normalizedExportScope;
  }
  if (normalizedExportedAt) {
    appProperties[APP_PROPERTY_EXPORTED_AT_KEY] = normalizedExportedAt;
  }

  const metadata = {
    name: fileName,
    parents: [folderId],
    appProperties,
  };

  const body = new Blob(
    [
      `--${boundary}\r\n`,
      "Content-Type: application/json; charset=UTF-8\r\n\r\n",
      JSON.stringify(metadata),
      "\r\n",
      `--${boundary}\r\n`,
      `Content-Type: ${mimeType}\r\n\r\n`,
      params.blob,
      "\r\n",
      `--${boundary}--`,
    ],
    { type: `multipart/related; boundary=${boundary}` },
  );

  const uploaded = await driveRequestJson<DriveFileEntry>(
    accessToken,
    `${DRIVE_UPLOAD_ENDPOINT}?uploadType=multipart&fields=id,name,mimeType,modifiedTime,size,appProperties`,
    {
      method: "POST",
      headers: {
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );

  if (!uploaded.id) {
    throw new Error("Google Drive не вернул id загруженного файла.");
  }

  return mapDriveFileEntryToMeta({
    ...uploaded,
    name: uploaded.name || fileName,
    appProperties: uploaded.appProperties ?? appProperties,
  });
}

export async function listBackupsInGoogleDrive(
  accessToken: string,
  folderId: string,
  pageSize = 25,
): Promise<GoogleDriveFileMeta[]> {
  const normalizedFolderId = folderId.trim();
  if (!normalizedFolderId) {
    throw new Error("Для синхронизации нужен Google Drive folderId.");
  }

  const normalizedPageSize = Math.max(1, Math.min(100, Math.floor(pageSize || 25)));
  const query = buildBackupFilesQuery(normalizedFolderId);
  const result = await driveRequestJson<DriveFileListResponse>(
    accessToken,
    `${DRIVE_FILES_ENDPOINT}?q=${encodeURIComponent(
      query,
    )}&orderBy=modifiedTime desc&pageSize=${normalizedPageSize}&fields=files(id,name,mimeType,modifiedTime,size,appProperties),nextPageToken`,
  );

  return (result.files ?? [])
    .filter((entry) => Boolean(entry.id))
    .map((entry) => mapDriveFileEntryToMeta(entry));
}

export async function findLatestBackupInGoogleDrive(
  accessToken: string,
  folderId: string,
): Promise<GoogleDriveFileMeta | null> {
  const backups = await listBackupsInGoogleDrive(accessToken, folderId, 1);
  return backups[0] ?? null;
}

export async function downloadGoogleDriveFileBlob(
  accessToken: string,
  fileId: string,
) {
  const normalizedFileId = fileId.trim();
  if (!normalizedFileId) {
    throw new Error("Не указан fileId для скачивания из Google Drive.");
  }
  return await driveRequestBlob(
    accessToken,
    `${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(normalizedFileId)}?alt=media`,
  );
}

export { DEFAULT_EXPORTS_FOLDER_NAME };
