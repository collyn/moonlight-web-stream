
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

    // -- Events
    private onCompositionEnd(event: CompositionEvent) {
        // iOS IME: when predictive text or accent characters are committed,
        // the compositionend event carries the final text
        if (event.data) {
            const customEvent: TextEvent = new CustomEvent("ml-text", {
                detail: { text: event.data }
            })
            this.eventTarget.dispatchEvent(customEvent)
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

        if ((event.inputType == "insertText" || event.inputType == "insertFromPaste") && event.data != null) {
            const customEvent: TextEvent = new CustomEvent("ml-text", {
                detail: { text: event.data }
            })

            this.eventTarget.dispatchEvent(customEvent)
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