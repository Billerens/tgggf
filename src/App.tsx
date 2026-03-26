import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { GeneratedPersonaDraft } from "./lmstudio";
import { generatePersonaDrafts, listModels } from "./lmstudio";
import { useAppStore } from "./store";
import { ChatPane } from "./components/ChatPane";
import { ChatDetailsModal } from "./components/ChatDetailsModal";
import { ErrorToast } from "./components/ErrorToast";
import { PersonaModal } from "./components/PersonaModal";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import type { Persona } from "./types";
import { createEmptyPersonaDraft, type PersonaModalTab, type SidebarTab } from "./ui/types";

export default function App() {
  const {
    personas,
    chats,
    messages,
    activePersonaState,
    activeMemories,
    activePersonaId,
    activeChatId,
    settings,
    isLoading,
    error,
    initialize,
    selectPersona,
    selectChat,
    savePersona,
    deletePersona,
    createChat,
    deleteChat,
    sendMessage,
    saveSettings,
    clearError,
  } = useAppStore();

  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("chats");
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showPersonaModal, setShowPersonaModal] = useState(false);
  const [showChatDetailsModal, setShowChatDetailsModal] = useState(false);
  const [personaModalTab, setPersonaModalTab] = useState<PersonaModalTab>("editor");
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const [personaDraft, setPersonaDraft] = useState(createEmptyPersonaDraft);
  const [editingPersonaId, setEditingPersonaId] = useState<string | null>(null);
  const [messageInput, setMessageInput] = useState("");
  const [settingsDraft, setSettingsDraft] = useState(settings);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  const [generationTheme, setGenerationTheme] = useState("");
  const [generationCount, setGenerationCount] = useState(3);
  const [generatedDrafts, setGeneratedDrafts] = useState<GeneratedPersonaDraft[]>([]);
  const [generationLoading, setGenerationLoading] = useState(false);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    setSettingsDraft(settings);
  }, [settings]);

  const loadModels = async (
    baseUrl: string,
    apiKey: string,
    lmAuth: typeof settingsDraft.lmAuth,
  ) => {
    setModelsLoading(true);
    try {
      const models = await listModels({ lmBaseUrl: baseUrl, apiKey, lmAuth });
      setAvailableModels(models);
      if (!models.includes(settingsDraft.model) && models.length > 0) {
        setSettingsDraft((v) => ({ ...v, model: models[0] }));
      }
    } catch (e) {
      setAvailableModels([]);
      useAppStore.setState({ error: (e as Error).message });
    } finally {
      setModelsLoading(false);
    }
  };

  useEffect(() => {
    if (!settingsDraft.lmBaseUrl.trim()) return;
    void loadModels(settingsDraft.lmBaseUrl, settingsDraft.apiKey, settingsDraft.lmAuth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.lmBaseUrl, settings.apiKey, settings.lmAuth]);

  const activePersona = useMemo(
    () => personas.find((p) => p.id === activePersonaId) ?? null,
    [personas, activePersonaId],
  );

  const activeChat = useMemo(
    () => chats.find((c) => c.id === activeChatId) ?? null,
    [chats, activeChatId],
  );

  const startEditPersona = (persona: Persona) => {
    setEditingPersonaId(persona.id);
    setPersonaDraft({
      name: persona.name,
      personalityPrompt: persona.personalityPrompt,
      appearancePrompt: persona.appearancePrompt,
      stylePrompt: persona.stylePrompt,
      advanced: persona.advanced,
      avatarUrl: persona.avatarUrl,
    });
    setShowPersonaModal(true);
    setPersonaModalTab("editor");
  };

  const onPersonaSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!personaDraft.name.trim()) return;
    await savePersona({ ...personaDraft, id: editingPersonaId ?? undefined });
    setEditingPersonaId(null);
    setPersonaDraft(createEmptyPersonaDraft());
  };

  const onResetDraft = () => {
    setEditingPersonaId(null);
    setPersonaDraft(createEmptyPersonaDraft());
  };

  const onSettingsSubmit = async (event: FormEvent) => {
    event.preventDefault();
    await saveSettings(settingsDraft);
    setShowSettingsModal(false);
  };

  const onMessageSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!messageInput.trim()) return;
    const value = messageInput;
    setMessageInput("");
    await sendMessage(value);
  };

  const onGenerateSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setGenerationLoading(true);
    try {
      const drafts = await generatePersonaDrafts(settings, generationTheme, generationCount);
      setGeneratedDrafts(drafts);
    } catch (e) {
      useAppStore.setState({ error: (e as Error).message });
    } finally {
      setGenerationLoading(false);
    }
  };

  const onSaveGenerated = async (draft: GeneratedPersonaDraft) => {
    await savePersona({
      name: draft.name,
      personalityPrompt: draft.personalityPrompt,
      appearancePrompt: draft.appearancePrompt,
      stylePrompt: draft.stylePrompt,
      advanced: draft.advanced,
      avatarUrl: draft.avatarUrl || "",
    });
  };

  const onMoveGeneratedToEditor = (draft: GeneratedPersonaDraft) => {
    setPersonaDraft({
      name: draft.name,
      personalityPrompt: draft.personalityPrompt,
      appearancePrompt: draft.appearancePrompt,
      stylePrompt: draft.stylePrompt,
      advanced: draft.advanced,
      avatarUrl: draft.avatarUrl || "",
    });
    setEditingPersonaId(null);
    setPersonaModalTab("editor");
  };

  const onToggleMobileTab = (tab: SidebarTab) => {
    if (sidebarTab === tab && mobileSidebarOpen) {
      setMobileSidebarOpen(false);
    } else {
      setSidebarTab(tab);
      setMobileSidebarOpen(true);
    }
  };

  return (
    <>
      <div className="aurora-bg" />
      <div className="messenger">
        <Sidebar
          sidebarTab={sidebarTab}
          setSidebarTab={setSidebarTab}
          chats={chats}
          personas={personas}
          activeChatId={activeChatId}
          activePersonaId={activePersonaId}
          onOpenPersonas={() => setShowPersonaModal(true)}
          onOpenSettings={() => setShowSettingsModal(true)}
          onCreateChat={() => void createChat()}
          onSelectChat={(chatId) => void selectChat(chatId)}
          onSelectPersona={(personaId) => void selectPersona(personaId)}
          onEditPersona={startEditPersona}
          isMobileOpen={mobileSidebarOpen}
          onCloseMobile={() => setMobileSidebarOpen(false)}
          onToggleMobileTab={onToggleMobileTab}
        />

        <ChatPane
          activeChat={activeChat}
          activePersona={activePersona}
          activeChatId={activeChatId}
          messages={messages}
          messageInput={messageInput}
          setMessageInput={setMessageInput}
          isLoading={isLoading}
          activePersonaState={activePersonaState}
          memoryCount={activeMemories.length}
          showSystemImageBlock={settings.showSystemImageBlock}
          showStatusChangeDetails={settings.showStatusChangeDetails}
          onDeleteChat={() => {
            if (!activeChatId) return;
            void deleteChat(activeChatId);
          }}
          onSubmitMessage={onMessageSubmit}
          onOpenSidebar={() => {
            setSidebarTab("personas");
            setMobileSidebarOpen(true);
          }}
          onOpenChatDetails={() => setShowChatDetailsModal(true)}
        />

        <ChatDetailsModal
          open={showChatDetailsModal}
          chat={activeChat}
          persona={activePersona}
          messages={messages}
          memories={activeMemories}
          runtimeState={activePersonaState}
          settings={settings}
          onClose={() => setShowChatDetailsModal(false)}
        />

        <SettingsModal
          open={showSettingsModal}
          settingsDraft={settingsDraft}
          availableModels={availableModels}
          modelsLoading={modelsLoading}
          setSettingsDraft={setSettingsDraft}
          onRefreshModels={() =>
            void loadModels(
              settingsDraft.lmBaseUrl,
              settingsDraft.apiKey,
              settingsDraft.lmAuth,
            )
          }
          onClose={() => setShowSettingsModal(false)}
          onSubmit={onSettingsSubmit}
        />

        <PersonaModal
          open={showPersonaModal}
          personas={personas}
          personaModalTab={personaModalTab}
          setPersonaModalTab={setPersonaModalTab}
          editingPersonaId={editingPersonaId}
          personaDraft={personaDraft}
          setPersonaDraft={setPersonaDraft}
          onClose={() => setShowPersonaModal(false)}
          onEditPersona={startEditPersona}
          onDeletePersona={(personaId) => void deletePersona(personaId)}
          onSubmitPersona={onPersonaSubmit}
          onResetDraft={onResetDraft}
          generationTheme={generationTheme}
          setGenerationTheme={setGenerationTheme}
          generationCount={generationCount}
          setGenerationCount={setGenerationCount}
          generationLoading={generationLoading}
          generatedDrafts={generatedDrafts}
          onSubmitGenerate={onGenerateSubmit}
          onSaveGenerated={(draft) => void onSaveGenerated(draft)}
          onMoveGeneratedToEditor={onMoveGeneratedToEditor}
        />

        <ErrorToast error={error} onClose={clearError} />
      </div>
    </>
  );
}
