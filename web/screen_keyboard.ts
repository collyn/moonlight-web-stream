
import { KEY_VALUE_MAPPINGS, SHIFT_CHARS } from "./stream/keyboard.js"

export type TextEvent = CustomEvent<{ text: string }>

export class ScreenKeyboard {

    private eventTarget = new EventTarget()
    private fakeElement = document.createElement("input")

    private visible: boolean = false

    constructor() {
        this.fakeElement.classList.add("hiddeninput")
        this.fakeElement.type = "text"
        this.fakeElement.name = "keyboard"
        this.fakeElement.autocomplete = "off"
        this.fakeElement.autocapitalize = "off"
        this.fakeElement.spellcheck = false
        if ("autocorrect" in this.fakeElement) {
            this.fakeElement.autocorrect = false
        }
        // Prevent native keyboard from showing until explicitly toggled
        this.fakeElement.inputMode = "none"
        // iOS: show "Done" button instead of "Return"
        this.fakeElement.enterKeyHint = "done"

        this.fakeElement.addEventListener("input", this.onKeyInput.bind(this))
        // iOS IME: compositionend fires when predictive text or accent characters are confirmed
        this.fakeElement.addEventListener("compositionend", this.onCompositionEnd.bind(this))

        document.addEventListener("click", this.hide.bind(this))
        this.fakeElement.addEventListener("blur", this.onBlur.bind(this))
    }

    getHiddenElement() {
        return this.fakeElement
    }

    show() {
        if (!this.visible) {
            this.visible = true
            // Enable native keyboard and allow focus
            this.fakeElement.inputMode = "text"
            this.fakeElement.style.pointerEvents = "auto"
            // Repopulate so delete works
            this.fakeElement.value = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            this.fakeElement.focus()
            // iOS: prevent scroll-to-input by scrolling back
            window.scrollTo(0, 0)
        }
    }
    hide() {
        if (this.visible) {
            this.visible = false
            // Disable native keyboard
            this.fakeElement.inputMode = "none"
            this.fakeElement.style.pointerEvents = "none"
            this.fakeElement.blur()
            // Restore viewport position
            window.scrollTo(0, 0)
        }
    }

    private onBlur() {
        // When the input loses focus naturally (e.g., iOS keyboard "Done" button),
        // sync our state
        if (this.visible) {
            this.visible = false
            this.fakeElement.inputMode = "none"
            this.fakeElement.style.pointerEvents = "none"
            // Restore viewport position
            window.scrollTo(0, 0)
        }
    }

    isVisible(): boolean {
        return this.visible
    }

    addKeyDownListener(listener: (event: KeyboardEvent) => void) {
        this.eventTarget.addEventListener("keydown", listener as any)
    }
    addKeyUpListener(listener: (event: KeyboardEvent) => void) {
        this.eventTarget.addEventListener("keyup", listener as any)
    }
    addTextListener(listener: (event: TextEvent) => void) {
        this.eventTarget.addEventListener("ml-text", listener as any)
    }

    /**
     * Try to convert a text character to keydown/keyup events.
     * This is critical for Linux remotes where sendText() uses the GTK Unicode
     * input method (Ctrl+Shift+U + hex), which produces "U+" garbage.
     * By sending key events instead, the server uses proper X11 keysyms.
     *
     * Returns true if ALL characters were converted to key events.
     * Returns false if any character couldn't be mapped (caller should use sendText fallback).
     */
    private tryDispatchAsKeyEvents(text: string): boolean {
        // For each character, check if it has a VK mapping
        for (const char of text) {
            const vkCode = KEY_VALUE_MAPPINGS[char]
            if (vkCode == null || vkCode === undefined) {
                // This character can't be mapped to a key event
                return false
            }
        }

        // All characters are mappable — dispatch key events for each
        for (const char of text) {
            const needsShift = SHIFT_CHARS.has(char)

            const keyDown = new KeyboardEvent("keydown", {
                key: char,
                code: "",
                shiftKey: needsShift,
            })
            const keyUp = new KeyboardEvent("keyup", {
                key: char,
                code: "",
                shiftKey: needsShift,
            })

            this.eventTarget.dispatchEvent(keyDown)
            this.eventTarget.dispatchEvent(keyUp)
        }

        return true
    }

    // -- Events
    private onCompositionEnd(event: CompositionEvent) {
        // iOS IME: when predictive text or accent characters are committed,
        // the compositionend event carries the final text
        if (event.data) {
            // Try to send as key events first (works better on Linux remotes)
            if (!this.tryDispatchAsKeyEvents(event.data)) {
                // Fallback to sendText for characters that can't be mapped
                const customEvent: TextEvent = new CustomEvent("ml-text", {
                    detail: { text: event.data }
                })
                this.eventTarget.dispatchEvent(customEvent)
            }
        }

        // Repopulate the input so that the deleteContent commands will work
        this.fakeElement.value = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }

    private onKeyInput(event: Event) {
        if (!(event instanceof InputEvent)) {
            return
        }
        // Skip composing events — we handle the final result in onCompositionEnd
        if (event.isComposing) {
            return
        }

        if ((event.inputType == "insertText" || event.inputType == "insertFromPaste" || event.inputType == "insertCompositionText" || event.inputType == "insertReplacementText") && event.data != null) {
            // Try to send as key events first (works better on Linux remotes)
            // sendText() on Linux uses Ctrl+Shift+U Unicode input which shows "U+" garbage
            if (!this.tryDispatchAsKeyEvents(event.data)) {
                // Fallback to sendText for characters that can't be mapped (e.g., emoji, CJK)
                const customEvent: TextEvent = new CustomEvent("ml-text", {
                    detail: { text: event.data }
                })
                this.eventTarget.dispatchEvent(customEvent)
            }
        } else if (event.inputType == "deleteContentBackward" || event.inputType == "deleteByCut") {
            const keyDown = new KeyboardEvent("keydown", {
                code: "Backspace"
            })
            const keyUp = new KeyboardEvent("keyup", {
                code: "Backspace"
            })

            this.eventTarget.dispatchEvent(keyDown)
            this.eventTarget.dispatchEvent(keyUp)
        } else if (event.inputType == "deleteContentForward") {
            const keyDown = new KeyboardEvent("keydown", {
                code: "Delete"
            })
            const keyUp = new KeyboardEvent("keyup", {
                code: "Delete"
            })

            this.eventTarget.dispatchEvent(keyDown)
            this.eventTarget.dispatchEvent(keyUp)
        } else if (event.inputType == "insertLineBreak") {
            // iOS "Done" / "Return" key
            const keyDown = new KeyboardEvent("keydown", {
                code: "Enter"
            })
            const keyUp = new KeyboardEvent("keyup", {
                code: "Enter"
            })

            this.eventTarget.dispatchEvent(keyDown)
            this.eventTarget.dispatchEvent(keyUp)
        }

        // Repopulate the input so that the deleteContent commands will work
        this.fakeElement.value = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
}