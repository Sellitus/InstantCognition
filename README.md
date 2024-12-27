# InstantCognition v2.0+

![InstantCognition Screenshot](assets/InstantCognition.png)
![InstantCognition Screenshot](assets/InstantCognition-full.png)

#### Windows / MacOS / Linux - SwiftLLM is now InstantCognition!


## Why does InstantCognition exist?
To access information you need and get back to what you were doing before, much faster and easier!

<br>

&nbsp;&nbsp;&nbsp;&nbsp;While using an AI Large Language Model (LLM), playing a game, researching a new topic, or just plain browsing the web, sometimes you need look something up, but for simple things it is slow and too much effort. First you need to open a new tab, then navigate to a website, type in a query, maybe even have to go through a couple of hoops after finding the area of the site you want, then finally accessing the information you need. InstantCognition makes this entire process tremendously faster by showing and focusing a Chromium browser instantly after hitting a simple key command (CTRL/CMD + Space), where you can immediately begin typing your query into your favorite AI like ChatGPT, a search engine like Google, or maybe even a wiki or a walkthrough for a game you're currently playing. As soon as you're finished getting all of the necessary information, hit the key command again (CTRL/CMD + Space) to hide InstantCognition and go right back to what you were doing before, instantly!!

&nbsp;&nbsp;&nbsp;&nbsp;You can add many 'Cognitizers', with predefined tabs that are used as the 'starting point' of any research you want to do (like the starting page of a search engine, where you can enter your search query, or the new conversation page or an AI LLM where you can send the LLM a prompt). There is an integrated 'browser tab', which catches CTRL/CMD + Clicked links in a single tab, so you don't open a ton of tabs just because you don't want to follow a link in the Cognitizer section. It also comes with the option to open in your default web browser instead of InstantCognition's built-in browser tab, when you're ready for your default full-browser's experience. MultiCognition mode allows you to show as many Cognitizer web pages next to each other as you want, so you can copy/paste your LLM prompt into a bunch of different LLMs at once, or simply have whatever websites you like open and visible as the same time. InstantCognition is designed with the idea of being as fast, secure and stable as possible without a bunch of useless extra features you probably won't ever need. However, there are plenty of useful options and features included too, such as a built-in adblocker, ability to launch the app when your computer is starting up, and much more!!



### All of the Coolest Features
- CTRL/CMD + Space :: Shows the InstantCognition window which lets you instantly query your favorite LLM, search engine, wiki or whatever you want, then hit the command again to instantly hide the window to go back to what you were doing before (can disable and enable the shortcut anytime using CTRL/CMD + ALT/OPTION + L, so it doesn't interfere with other apps that use CTRL/CMD + Space)
- Customizable 'Cognitizer Tabs' (Improved in v2.0!) :: You can put any LLM/website and label you'd like (add/remove/edit in config.json file, up to 50 Cognitizers)
- One Compact 'Browser Tab' :: Catches CTRL/CMD + Click events to open links on the right side of the window. You can also click 'Open Link External' to open the link in your default browse
- MultiCognition (New in v2.0!) :: Allows you to open as many of your tabs side-by-side, so you can see and use multiple web pages at once
- Ad-Blocker (Improved in v2.0!) :: Ad-blocker that gets rid of all of the bad stuff but won't interfere with your favorite web apps
- Find Bar (New in v2.0!) :: Integrated like any browser text find functionality, open with CTRL/CMD + F
- Intuitive Design Philosophy (New in v2.0!) :: Large focus on making things 'just work' how you'd expect them to work, including swipe gestures. Lots of helpful functions are included in the right-click menu and context menu
- Fast, Secure and Stable Code Design (Improved in v2.0!) :: Many changes have been made to improve overall performance. To name a few: Cognitizer tabs sleep when not selected, Cognitizer pages are not loaded until selected, frees up RAM used by InstantCognition aggressively, utilizes Electron which runs securely on Chromium, and much more
### Settings
- Prevent Menu Expansion: Does not expand the menu when hovering your mouse over it
- Enable Ad Blocker: Ad blocker with block lists included. Should not affect most website functionality
- Launch at OS Startup: Automatically runs InstantCognition when starting up your computer



#### NOTE: All scripts are compatible with both Ubuntu and MacOS, including Ubuntu on Windows Subsystem for Linux

## Setup Build Environment

- sudo bash setup_env.sh



## How to Build

- ./bld_and_cp.sh

Simply run the command with no arguments, which will automatically detect your OS, update NPM packages, build then copy InstantCognition to your Desktop if on Windows or your user App folder if on MacOS, and then run the App:



### Only create an OSX ARM / x64 .app file: 
- npm run package-mac-arm
- npm run package-mac-x64

### Only create a Windows ARM / x64 .exe file/folder: 
- npm run package-win-arm
- npm run package-win-x64

### Only create a Linux build file/folder: 
- npm run package-lin-arm
- npm run package-lin-x64



## Known Issues

- Some logins using a Google account don't work properly. For example, you can't login to Claude by clicking the link to login with your Google account. (NOTE: You can almost always login to an account without the official Google login)



## TODO
- Add adjustable bar between the LLM and browser webviews, so the split can be resized
    - Don't save and load this setting
- Add keyboard shortcuts to go between LLMs, but only put these shortcuts into effect if the window is focused (not global)
    - Shortcuts all start with ctrl + shift. Up and down would go through the list. Specific key letters could be added for specific LLMs (C for Copilot, G for Gemini, etc)
    - Add settings for modifier (ctrl + shift) and to customize the letter for specific LLMs
- Add setting to customize the global 'show window' shortcut (ctrl + space)
- Develop ability to package the app into a single .exe file, to make it portable.
    - The settings config.json and other files will be saved next to the portable .exe file
- Implement automatic updating
    - First implementation could be crude, like just redownloading from a new release
- Ensure all account types can login to all supported LLMs
    - Email login / google login / facebook login / etc
- Design unit tests and system tests for the release workflow
