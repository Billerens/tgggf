# i2i_2 Enhancement Mapping

Источник логики:
- `E:/Projects/tg-gf/src/App.tsx` (`enhanceLookImage`)
- `E:/Projects/tg-gf/src/comfy.ts` (`generateComfyImages`, `applyDetailing`)
- `E:/Projects/tg-gf/public/comfy_api_i2i_2.json`

## 1) Что формируется в `enhanceLookImage`

| Поле запроса (ComfyGenerationItem) | Значение при улучшении |
|---|---|
| `flow` | `i2i` |
| `prompt` | `enhancePrompt` = source/base prompt + `same person, same identity, same outfit, same framing, preserve composition, highly detailed` |
| `width`, `height` | Размеры исходного улучшаемого изображения (`getImageDimensions`) |
| `seed` | `enhanceSeed` (детерминированно от source seed/url/target + time) |
| `checkpointName` | `personaDraft.imageCheckpoint` (если задан) |
| `styleReferenceImage` | Улучшаемая картинка (`imageUrl`) |
| `styleStrength` | `1` |
| `compositionStrength` | `1` |
| `forceHiResFix` | `true` |
| `enableUpscaler` | `true` |
| `upscaleFactor` | `1.25` |
| `outputNodeTitleIncludes` | `["Preview after Detailing"]` |
| `strictOutputNodeMatch` | `true` |
| `pickLatestImageOnly` | `true` |
| `detailing.enabled` | `true` |
| `detailing.level` | `lookDetailLevel` (`off` -> `medium`) |
| `detailing.targets` | `all -> [face,eyes,nose,lips,hands]`, иначе строго выбранная цель (`face/eyes/nose/lips/hands`) |
| `detailing.prompts` | `promptBundle.detailPrompts` |

## 2) Куда это попадает в `i2i_2` (узлы/входы)

| Источник из запроса | Нода/титул в flow | ID | Вход |
|---|---|---|---|
| `prompt` | `IMG2IMG prompt` | `991` | `inputs.text` |
| `prompt` | `Positive` | `984` | `inputs.value` |
| `prompt` | `fallback string` | `1051` | `inputs.value` |
| prompt routing | `prompt switch` (если узел есть в шаблоне) | `891` | `inputs.Input = 2` |
| `seed` | `Seed` | `522` | `inputs.seed` |
| `styleReferenceImage` (после upload) | `Load (multiple) Images` | `745` | `inputs.selected_paths`, `inputs["Select images"]` |
| `styleReferenceImage` (после upload) | `Load Last Generated Image` | `1050` | `inputs.select_image`, `inputs.image="<file> [input]"`, `inputs.auto_refresh=false` |
| source routing | `Input Image Switch` (если узел есть в шаблоне) | `679:572` | `inputs.Input = 1` |
| `styleReferenceImage` (после upload) | `Alternative style image` | `574` | `inputs.image` |
| `styleStrength` | `IPAdapter Style Strength` | `430` | `inputs.Xi`, `inputs.Xf` |
| `forceHiResFix`/`enableUpscaler` | `Use Hi-Res Fix? (Recommended)` | `935` | `inputs.value=true` |
| `upscaleFactor` | `Upscale factor switch` (по title search) | `923:1030` | соответствующий числовой input |

Примечание: в актуальном `i2i 5.1 (2).json` узлы `891` и `679:572` отсутствуют, поэтому эти шаги мягко пропускаются и не блокируют запуск.

## 3) Detailing-мэппинг при улучшении

### Глобальные denoise для i2i

| `detailing.level` | `Denoise` (`949`,`558`) | `Hi-Res Fix Denoise` (`946`,`670`) |
|---|---:|---:|
| `soft` | `0.62` | `0.22` |
| `medium` | `0.72` | `0.30` |
| `strong` | `0.82` | `0.38` |

### Пер-часть (включено только для выбранных targets)

| Часть | Denoise title | Узел | Значение (medium) |
|---|---|---|---:|
| face | `Denoise Face` | `491` | `0.14` |
| eyes | `Denoise Eyes` | `489` | `0.14` |
| nose | `Denoise Nose` | `492` | `0.18` |
| lips | `Denoise Lips` | `493` | `0.20` |
| hands | `Denoise Hands` | `494` | `0.22` |

Для невыбранных частей ставится `0.01`.  
Erotic-ветки всегда принудительно отключаются (`Nipples/Vagina/Penis` bypass=true и denoise=0.01).

### Bypass-узлы частей

| Часть | Bypass node ID | Правило |
|---|---|---|
| face | `897` | `bypass = !targets.has("face")` |
| eyes | `907` | `bypass = !targets.has("eyes")` |
| nose | `910` | `bypass = !targets.has("nose")` |
| lips | `908` | `bypass = !targets.has("lips")` |
| hands | `900` | `bypass = !targets.has("hands")` |

Плюс `Inpaint?` (`953`) при активном detailing выставляется в `true`.

### Промпты детализации по частям

| Target | CLIPTextEncode title (по exact title) |
|---|---|
| face | `Face Clip transform` |
| eyes | `Eyes Clip transform` |
| nose | `Nose Clip transform` |
| lips | `Lips Clip transform` |
| hands | `Hands Clip transform` |

## 4) Как выбирается итоговое изображение

| Шаг | Правило |
|---|---|
| Поиск output узлов | Только title, содержащий `Preview after Detailing` |
| `strictOutputNodeMatch` | Если целевой preview-узел пустой, выбрасывается ошибка |
| `pickLatestImageOnly` | Берется последний файл из найденного узла |
| Возврат в UI | URL из `/view?...` -> `localizeImageUrls` -> compare modal |
