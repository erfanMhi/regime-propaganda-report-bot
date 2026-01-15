# Instagram Report Bot - Chrome Extension

A Chrome extension version of the Instagram Report Bot. No Python, no terminal, no debug mode required.

## ⚡ Installation

1. Download this `extension` folder
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked**
5. Select the `extension` folder
6. Done! You'll see the extension icon in your toolbar

## 🚀 How to Use

1. **Open Instagram** in a tab and make sure you're logged in
2. **Click the extension icon** in your toolbar
3. The target list is pre-filled. Add/remove usernames as needed (one per line, without @)
4. **Click Start** - the bot will:
   - Navigate to each profile
   - Click through the report flow (Report → Violence → Calling for Violence)
   - Wait 15-25 seconds between profiles
5. **Click Stop** anytime to pause

## ⚠️ Caution

Using bots on Instagram **may result in a temporary ban**. Use at your own risk.

That said, I've used this tool multiple times without issues - the probability seems low.

## 📝 Adding Targets

Edit the text area in the popup. One username per line, without @:

```
username1
username2
username3
```

The list is saved automatically.

## ❓ Troubleshooting

| Problem | Solution |
|---------|----------|
| "Instagram Tab: Not Found" | Open instagram.com in a tab first |
| Report flow stops early | Instagram UI may have changed. Check console for errors |
| "Rate limited" | Wait 60 seconds, bot will resume automatically |

---

**Fight back against the Islamic regime's tyranny** ✊
