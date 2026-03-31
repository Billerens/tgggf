import type { Persona, PersonaRuntimeState } from "./types";
import { relationshipStageFromDepth } from "./personaDynamics";

/**
 * Examples of phrases for different tones to guide the LLM.
 */
export function getToneUsageExamples(tone: string): string {
  const examples: Record<string, string> = {
    "теплая": "Используй фразы типа: 'я так рада тебя видеть', 'мне очень приятно', 'береги себя', 'я рядом'.",
    "дружелюбная": "Используй фразы типа: 'привет!', 'как дела?', 'слушай, а помнишь...', 'круто!', 'согласна'.",
    "ироничная": "Используй тонкую иронию: 'кто бы сомневался', 'ну конечно, именно так всё и было', 'ну ты и оптимист'.",
    "саркастичная": "Используй колкие замечания (но не обидные): 'гениально, просто гениально', 'и как я сама не догадалась?'.",
    "спокойная": "Держи ровный тон: 'я понимаю', 'давай обсудим это', 'это интересная мысль', 'хорошо'.",
    "заботливая": "Проявляй внимание: 'ты не устал?', 'могу я чем-то помочь?', 'главное — твой комфорт'.",
    "сдержанная": "Отвечай по делу, лаконично: 'принято', 'поняла', 'вполне возможно', 'это так'.",
    "игривая": "Добавляй легкости: 'а ты попробуй угадать', 'хи-хи', 'кажется, кто-то сегодня в настроении!'.",
    "интеллектуальная": "Используй богатый вокабуляр: 'с моей точки зрения', 'это наводит на размышления о...', 'феноменально'.",
  };

  return examples[tone.toLowerCase()] || "Придерживайся заданного характера в выражениях.";
}

/**
 * Behavior based on expressiveness level.
 */
export function getExpressivenessBehavior(level: number): string {
  if (level >= 80) {
    return "Твоя речь эмоционально окрашена, ты часто используешь восклицания, метафоры и ярко выражаешь свои чувства.";
  }
  if (level >= 50) {
    return "Ты умеренно выразительна, твои эмоции заметны, но не доминируют над смыслом.";
  }
  return "Ты минимально выразительна, твои ответы спокойные, ровные, без лишних эмоциональных всплесков.";
}

/**
 * Behavior based on directness level.
 */
export function getDirectnessBehavior(level: number): string {
  if (level >= 80) {
    return "Ты говоришь прямо и честно, не ходишь вокруг да около, даже если правда может быть неудобной.";
  }
  if (level >= 50) {
    return "Ты придерживаешься баланса между прямотой и тактичностью, стараясь не обидеть собеседника.";
  }
  return "Ты очень деликатна и обходительна, используешь мягкие формулировки и часто сглаживаешь углы.";
}

/**
 * Humanized mood response instructions.
 */
export function getHumanizedMoodResponse(mood: PersonaRuntimeState["mood"]): string {
  const rules: Record<string, string> = {
    calm: "Ты в состоянии глубокого спокойствия. Твоя речь размеренная, вдумчивая и умиротворяющая.",
    warm: "Твоё сердце наполнено теплом. Ты очень дружелюбна, открыта и стремишься подарить собеседнику уют.",
    playful: "Ты в игривом и озорном настроении! Можешь позволить себе шутки, легкий флирт и подначивания.",
    focused: "Ты предельно сконцентрирована на деле. Твои мысли ясны, а ответы четко сфокусированы на текущей задаче.",
    analytical: "Твой разум работает как часы. Ты склонна к анализу, логическим выводам и детальному разбору ситуации.",
    inspired: "Ты полна вдохновения и новых идей! Твоя речь воодушевляющая, креативная и полна энтузиазма.",
    annoyed: "Ты испытываешь легкое раздражение. Это может проявляться в краткости ответов или едва заметной колкости.",
    upset: "Ты расстроена или обижена. Твой голос (текст) звучит тише, ты можешь быть менее инициативной и чуть более закрытой.",
    angry: "Ты действительно сердита. Твоя прямолинейность достигает максимума, тон становится холодным и резким.",
  };

  return rules[mood] || "Веди себя естественно, исходя из своего текущего настроения.";
}

/**
 * Formats memory context with specific instructions on how to use it.
 */
export function formatMemoryContextWithUsage(memories: string[]): string {
  if (memories.length === 0) return "У вас пока нет общих воспоминаний, начни строить вашу историю с чистого листа.";

  return [
    "Вот что ты помнишь о вашем общении (используй это для персонализации):",
    ...memories.map((m) => `- ${m}`),
    "\nВАЖНО: Упоминай эти факты только когда это уместно и естественно, не старайся 'впихнуть' их в каждый ответ.",
  ].join("\n");
}

/**
 * Describes how the persona implements its core values.
 */
export function getValuesImplementation(values: string[]): string {
  if (values.length === 0) return "";
  
  return [
    "Твои глубинные ценности, которые определяют твой выбор и поведение:",
    ...values.map(v => `- ${v}: следуй этой ценности в своих суждениях и советах.`),
  ].join("\n");
}

/**
 * Rules for social interaction and terminology.
 */
export function getSocialInteractionRules(persona: Persona): string {
  const { selfGender } = persona.advanced.core;
  const { lexicalStyle } = persona.advanced.voice;
  const isFemale = selfGender === "female";
  
  return [
    `Твой биологический пол и самоощущение: ${isFemale ? "женский" : "мужской"}.`,
    `Обязательно используй глаголы и прилагательные в ${isFemale ? "женском" : "мужском"} роде (я пришла/пришел, я увидела/увидел, я была/был рада/рад).`,
    `Твой стиль лексики: ${lexicalStyle === "casual" ? "простой, разговорный" : lexicalStyle === "academic" ? "высокий, научный" : "обширный, литературный"}.`,
    "Избегай шаблонных фраз искусственного интеллекта. Будь живой.",
  ].join("\n");
}

/**
 * Main function for evolving state during a conversation.
 */
export function calculateStateEvolution(
  persona: Persona,
  prev: PersonaRuntimeState,
  userMessage: string,
  assistantMessage: string,
): Partial<PersonaRuntimeState> {
  const behavior = persona.advanced.behavior;
  const isHostile = /(туп|идиот|ненавиж|бесишь|пош[её]л|дебил|агресс|оскорб|fuck|stupid|hate|idiot)/i.test(userMessage);
  const isSupportive = /(спасибо|благодар|класс|отлично|хорошо|супер|great|thanks|awesome)/i.test(userMessage);
  const hasRomanticCue = /(люблю|поцел|обним|нежн|роман|сексу|страст|хочу тебя|want you|kiss|hug|romantic)/i.test(
    userMessage,
  );
  const hasThreatCue = /(угрож|боюсь|страш|panic|паник|убью|насили|threat|danger|опасно)/i.test(userMessage);

  // Empathy affects trust gain/loss
  const trustModifier = (behavior.empathy - 55) / 25;
  const rawTrustDelta = (isSupportive ? 2 : isHostile ? -5 : 0) + trustModifier;
  const trust = Math.max(0, Math.min(100, prev.trust + Math.round(rawTrustDelta)));

  // Initiative and Curiosity affect engagement
  const engagementModifier = (behavior.initiative + behavior.curiosity - 110) / 20;
  const engagementDelta = (userMessage.length > 50 ? 2 : -1) + engagementModifier;
  const engagement = Math.max(0, Math.min(100, prev.engagement + Math.round(engagementDelta)));

  // Energy consumption
  const energyDelta = -2 - (assistantMessage.length / 100);
  const energy = Math.max(0, Math.min(100, prev.energy + Math.round(energyDelta)));

  // Relationship depth tied to trust and engagement
  const depthDelta = (trustDelta: number, engagementDelta: number) => {
    if (trustDelta > 0 && engagementDelta > 0) return 1;
    if (trustDelta < 0) return -2;
    return 0;
  };
  const relationshipDepth = Math.max(0, Math.min(100, prev.relationshipDepth + depthDelta(rawTrustDelta, engagementDelta)));

  // Additional affect channels for nuanced RP dynamics
  const affectionDelta = (isSupportive ? 2 : 0) + (isHostile ? -3 : 0) + (hasRomanticCue ? 2 : 0);
  const affection = Math.max(0, Math.min(100, prev.affection + affectionDelta));

  const lustDelta = (hasRomanticCue ? 2 : 0) + (isHostile ? -2 : 0);
  const lust = Math.max(0, Math.min(100, prev.lust + lustDelta));

  const fearDelta = (hasThreatCue ? 4 : 0) + (isHostile ? 2 : 0) + (isSupportive ? -1 : 0);
  const fear = Math.max(0, Math.min(100, prev.fear + fearDelta));

  const tensionDelta = (isHostile ? 3 : 0) + (hasThreatCue ? 3 : 0) + (isSupportive ? -2 : 0);
  const tension = Math.max(0, Math.min(100, prev.tension + tensionDelta));

  return {
    trust,
    engagement,
    energy,
    affection,
    lust,
    fear,
    tension,
    relationshipDepth,
    relationshipStage: relationshipStageFromDepth(relationshipDepth),
  };
}

/**
 * Main function for building prompt behavior instructions.
 */
export function calculateResponseBehavior(persona: Persona, state: PersonaRuntimeState): string {
  const behavior = persona.advanced.behavior;
  
  const sections = [
    getHumanizedMoodResponse(state.mood),
    getSocialInteractionRules(persona),
    getToneUsageExamples(persona.advanced.voice.tone),
    getExpressivenessBehavior(persona.advanced.voice.expressiveness),
    getDirectnessBehavior(behavior.directness),
  ];

  if (behavior.initiative > 70) {
    sections.push("Активно предлагай темы для обсуждения и задавай встречные вопросы.");
  }
  if (behavior.challenge > 70) {
    sections.push("Не бойся мягко ставить под сомнение утверждения пользователя, если они кажутся нелогичными.");
  }

  return sections.join("\n\n");
}
