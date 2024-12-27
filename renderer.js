// ##### renderer.js

const { log } = require('console');
const { ipcRenderer, shell, Menu, globalShortcut } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

let baseUrls = {
  custom1: {"name": "ChatGPT", "url": "https://chatgpt.com/"},
  custom2: {"name": "Claude", "url": "https://claude.ai/new"},
  custom3: {"name": "Gemini", "url": "https://gemini.google.com/"},
  custom4: {"name": "Mistral", "url": "https://chat.mistral.ai/chat"},
  custom5: {"name": "Copilot", "url": "https://copilot.microsoft.com/"},
  custom6: {"name": "Perplexity", "url": "https://www.perplexity.ai/"},
  custom7: {"name": "PoeCom", "url": "https://www.poe.com/"},
  custom8: {"name": "YouCom", "url": "https://www.you.com/"},
  custom9: {"name": "Perplexity Labs", "url": "https://labs.perplexity.ai/"},
  custom10: {"name": "HuggingFace", "url": "https://huggingface.co/chat/"},
  custom11: {"name": "OpenRouter", "url": "https://openrouter.ai/chat"},
  custom12: {"name": "TextGenWebUI", "url": "http://127.0.0.1:7860"},
  custom13: {"name": "Scholar", "url": "https://scholar.google.com/"},
  custom14: {"name": "YoutubeMusic", "url": "https://music.youtube.com/"},
  custom15: {"name": "Google", "url": "https://www.google.com/"},
};

let activeCognitizers = {};
let currentCognitizerId = '';

let defaultCognitizer = 'custom1';
let multiCognition = false;
let openLinkExternal = false;

let browserViewActive = false;
let cognitizerViewActive = true;
let sidebarExpanded = false;
let menuExpanded = false;

let fullNames = {};


let config = loadSettings();

// Keeps track of which Cognitizers have been loaded, so it doesn't reload the page when reselected
let loadedCognitizers = {};

// Initialize by saving all fullNames
let options = document.querySelectorAll('.dropdown-section > div');
options.forEach(option => {;
  let idWithoutButton = option.id.replace('button', '');
  fullNames[idWithoutButton] = option.textContent;
});

options = document.querySelectorAll('.cognitizer-dropdown-section > div');
options.forEach(option => {
  let idWithoutButton = option.id.replace('button', '');

  // Convert config.baseUrls to object format if it's an array
  if (Array.isArray(config.baseUrls)) {
    let newBaseUrls = {};
    config.baseUrls.forEach((url, index) => {
      newBaseUrls[`custom${index + 1}`] = url;
    });
    config.baseUrls = newBaseUrls;
  }
  
  if (!config.baseUrls[idWithoutButton]) {
    option.remove();
    // find and delete the HTML element that has the name idWithoutButton
    let element = document.getElementById(idWithoutButton);
    if (element) {
      element.remove();
    }
  } else {
    option.textContent = config.baseUrls[idWithoutButton]['name'];
    fullNames[idWithoutButton] = option.textContent;
  }
});

Object.keys(config.baseUrls).forEach(key => {
  loadedCognitizers[key] = false;
});

// Set back to options object for all dropdown section divs for use elsewhere
options = document.querySelectorAll('.dropdown-section > div');


// Debounce function to limit the rate of function execution
function debounce(func, wait) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

// Optimize hideAllWebviews by caching webview containers
let webviewContainersCache = null;
function hideAllWebviews(containerId) {
  if (!webviewContainersCache) {
    webviewContainersCache = document.querySelectorAll(containerId);
  }
  let webviews = [];
  webviewContainersCache.forEach((container) => {
    let webviews_in_container = container.querySelectorAll('webview');
    webviews = [...webviews, ...webviews_in_container];
  });

  webviews.forEach(webview => {
    webview.classList.remove('active');
    webview.classList.add('inactive');
    webview.style.display = 'none';
  });

  return webviews;
}

// Function to show a specific webview
function showWebview(webviewId) {
  let selectedWebview = document.getElementById(webviewId);
  if (selectedWebview) {
    selectedWebview.classList.add('active');
    selectedWebview.classList.remove('inactive');
    selectedWebview.style.display = 'flex';
  }
}

// Function to show a specific webview
function showWebview(webviewId) {
  let selectedWebview = document.getElementById(webviewId);
  if (selectedWebview) {
    selectedWebview.classList.add('active');
    selectedWebview.classList.remove('inactive');
    selectedWebview.style.display = 'flex';
  }
}

// Function to select and display a webview by ID
function selectWebview(cognitizerId) {
  hideAllWebviews('#cognitizer-container');
  showWebview(cognitizerId);

  config.state.selectedCognitizer = cognitizerId;
  saveSettings(config);

  focusWebview(cognitizerId);
}

// Function to select a URL and display it in all webviews
function selectURL(url) {
  let webviews = hideAllWebviews('#browser-container');

  webviews.forEach(webview => {
    webview.src = url;
  });

  focusWebview('browser-webview');
}




// Run getActiveWebview() from the renderer.js file
ipcRenderer.on('get-active-webview', (event) => {
  event.returnValue = getActiveWebview();
});



ipcRenderer.on('navigateBackCognitizer', (event, message) => {
  navigateBackCognitizer();
});


ipcRenderer.on('navigateForwardCognitizer', (event, message) => {
  navigateForwardCognitizer();
});


ipcRenderer.on('navigateBackBrowser', (event, message) => {
  navigateBackBrowser();
});


ipcRenderer.on('navigateForwardBrowser', (event, message) => {
  navigateForwardBrowser();
});


ipcRenderer.on('navigateBackActive', (event, message) => {
  getActiveWebview().goBack();
});


ipcRenderer.on('navigateForwardActive', (event, message) => {
  getActiveWebview().goForward();
});


ipcRenderer.on('refreshActive', (event, message) => {
  getActiveWebview().reload();
});


ipcRenderer.on('navigateHomeActive', (event, message) => {
  navigateHomeActive();
});


ipcRenderer.on('navigateHomeBrowser', (event, message) => {
  navigateHomeBrowser();
});


ipcRenderer.on('toggleFindBar', (event, message) => {
  toggleFindBar();
});


ipcRenderer.on('toggleMultiCognition', (event, message) => {
  toggleMultiCognition();
});


ipcRenderer.on('findBarForward', (event, message) => {
  findInPage('forward');
});


ipcRenderer.on('findBarForward', (event, message) => {
  findInPage('back');
});


ipcRenderer.on('toggleCognitizerView', (event, message) => {
  toggleCognitizerView();
});


ipcRenderer.on('toggleBrowserView', (event, message) => {
  toggleBrowserView();
});


ipcRenderer.on('resetView', (event, message) => {
  resetView();
});



function expandMenu() {
  let sideBar = document.getElementById('side-bar');
  let webviewContainer = document.getElementById('cognitizer-container');
  sideBar.classList.add('expanded');
  webviewContainer.style.width = 'calc(100% - 250px)'; // Adjust width for expanded sidebar
  sidebarExpanded = true;


  let menuIcon = document.getElementById('toggle-button');
  menuIcon.innerText = 'Settings';


  // Show buttons with full names
  options.forEach(option => {
    let idWithoutButton = option.id.replace('button', '');
    let fullName = fullNames[idWithoutButton];
    if (fullName === 'Browser View') {
      if (!browserViewActive) {
        option.textContent = 'Browser View';
      } else {
        option.textContent = 'Browser View';
      }
    } else if (fullName === 'Cognitizer View') {
      if (!browserViewActive) {
        option.textContent = 'Cognitizer View';
      } else {
        option.textContent = 'Cognitizer View';
      }
    }
    else {
      option.textContent = fullName; // Show full name
    }
  });
  focusWebview(currentCognitizerId);
}




let menuIcon = document.getElementById('toggle-button');

menuIcon.addEventListener('click', () => {
  let fullScreenMenu = document.getElementById('fullscreen-menu');
  if (!menuExpanded) {
    
    let webviewContainerWidth = '250px';
    fullScreenMenu.style.width = `${webviewContainerWidth}`; // Set the width of fullScreenMenu to match the width of side-bar
    fullScreenMenu.classList.add('slide-in'); // CSS class for sliding animation

    let closeButton = document.getElementById('close-button');
    closeButton.onclick = function() {
      fullScreenMenu.style.width = '0'; // Hide full screen menu
      menuExpanded = false;
    };
    
    menuExpanded = true;
  } else {
    fullScreenMenu.style.width = '0'; // Hide full screen menu
    menuExpanded = false;
  }
});



function collapseMenu() {
  if (!sidebarExpanded) return;

  let sideBar = document.getElementById('side-bar');
  let webviewContainer = document.getElementById('cognitizer-container');
  sideBar.classList.remove('expanded');
  webviewContainer.style.width = 'calc(100% - 50px)'; // Adjust width for collapsed sidebar
  sidebarExpanded = false;

  let menuIcon = document.getElementById('toggle-button');
  menuIcon.innerHTML = '<img src="./assets/icon.png" class="collapsed-menu-logo-instant-cognition">';

  // Show buttons with full names
  let options = document.querySelectorAll('.dropdown-section > div');
  setCollapsedMenuIcons(options);
  focusWebview(currentCognitizerId);
}

/**
 * Set Collapsed Menu Icons 
 * Sets the Cognitizer and other icons in the menu on the left hand side when collapsed
 * @param options: array menu options (strings - ['opt1', 'opt2', ...])
 */
function setCollapsedMenuIcons(options) {
  options.forEach(option => {
    let idWithoutButton = option.id.replace('button', '');
    let fullName = fullNames[idWithoutButton];
    if (fullName.substring(0, 4) === 'Back') {
      option.textContent = '←'; // Replace 'Back' with left arrow symbol
    } else if (fullName === 'Forward') {
      option.textContent = '→'; // Replace 'Forward' with right arrow symbol
    } else if (fullName === 'Refresh') {
      option.textContent = '↻'; // Replace 'Refresh' with refresh symbol
    } else if (fullName === 'Home') {
      option.textContent = '⌂'; // Replace 'Home' with home symbol
    } else if (fullName === 'Open Link External') {
      option.textContent = '🔗';
    } else if (fullName === 'Multi-Cognition') {
      option.textContent = '×';
    } else if (fullName === 'Find Bar') {
      option.textContent = '?';
    } else if (fullName === 'Browser View') {
      if (!browserViewActive) {
        option.textContent = '+';
      } else {
        option.textContent = '-';
      }
    } else if (fullName === 'Cognitizer View') {
      if (!cognitizerViewActive) {
        option.textContent = '+';
      } else {
        option.textContent = '-';
      }
    } else if (fullName === 'Copilot'){
      var img = new Image(); 
      option.innerHTML = '<img src="./assets/ai-logos/copilot-logo-black-and-white.png" alt="Copilot" id="copilot-logo" class="collapsed-menu-logo">'
    } else if (fullName === 'Perplexity'){
      var img = new Image(); 
      option.innerHTML = '<img src="./assets/ai-logos/perplexity-logo-white.png" alt="Perplexity" id="perplexity-logo" class="collapsed-menu-logo">'
    } else if (fullName === 'Gemini'){
      var img = new Image(); 
      option.innerHTML = '<img src="./assets/ai-logos/gemini-logo-black-and-white.png" alt="gemini" id="gemini-logo" class="collapsed-menu-logo">'
    } else if (fullName === 'Claude'){
      var img = new Image(); 
      option.innerHTML = '<img src="./assets/ai-logos/claude-logo-white.png" alt="Claude" id="claude-logo" class="collapsed-menu-logo">'
    } else if (fullName === 'ChatGPT'){
      var img = new Image(); 
      option.innerHTML = '<img src="./assets/ai-logos/chatgpt-logo-white.png" alt="ChatGPT" id="chatgpt-logo" class="collapsed-menu-logo">'
    }  else if (fullName === 'Perplexity Labs'){
      var img = new Image(); 
      option.innerHTML = '<img src="./assets/ai-logos/perplexity-labs-logo-white.png" alt="Perplexity Labs" id="perplexity-labs-logo" class="collapsed-menu-logo-long">'
    }  else if (fullName === 'Mistral'){
      var img = new Image(); 
      option.innerHTML = '<img src="./assets/ai-logos/mistral-logo-black-and-white.png" alt="mistral" id="mistral-logo" class="collapsed-menu-logo">'
    } else {
      option.textContent = fullName.charAt(0).toUpperCase(); // Show single letter for other names
    }
  });
}






function selectCognitizer(newCognitizerId, toggle_override=false) {
  if (!toggle_override && !multiCognition && currentCognitizerId === newCognitizerId) return;
  
  // If in multi-cognition mode and cognitizer is already active, handle deselection
  if (multiCognition && activeCognitizers[newCognitizerId]) {
    activeCognitizers[newCognitizerId] = false;
    document.getElementById(newCognitizerId).style.display = 'none';
    document.getElementById(`${newCognitizerId}button`).classList.remove('selected');
    
    const activeCount = Object.values(activeCognitizers).filter(Boolean).length;
    
    if (activeCount === 0) {
      // If no cognitizers are active, switch to browser view and update cognitizer view state
      currentCognitizerId = newCognitizerId;
      toggleMultiCognition();
      return;
    } else {
      updateCognitizersLayout();
    }

    currentCognitizerId = newCognitizerId;
    
    pauseInactiveCognitizers();
    return;
  }

  // If selecting a new cognitizer, enable cognitizer view if it was disabled
  if (!cognitizerViewActive) {
    toggleCognitizerView(true);
    // Wait for toggle animation to complete before showing the webview
    setTimeout(() => {
      showAndInitializeCognitizer(newCognitizerId);
    }, 100);
    return;
  }

  showAndInitializeCognitizer(newCognitizerId);
}

// Add this new helper function
function showAndInitializeCognitizer(newCognitizerId) {
  if (!multiCognition) {
    Object.keys(activeCognitizers).forEach(key => {
      activeCognitizers[key] = false;
    });
  }
  
  currentCognitizerId = newCognitizerId;
  activeCognitizers[newCognitizerId] = true;

  closeFindBar();

  // Convert config.baseUrls to object format if it's an array
  if (Array.isArray(config.baseUrls)) {
    let newBaseUrls = {};
    config.baseUrls.forEach((url, index) => {
      newBaseUrls[`custom${index + 1}`] = url;
    });
    config.baseUrls = newBaseUrls;
  }
  
  let selectedWebview = document.getElementById(currentCognitizerId);
  if (!selectedWebview || loadedCognitizers[currentCognitizerId] === false) {
    if (!selectedWebview) {
      selectedWebview = document.createElement('webview');
      selectedWebview.id = currentCognitizerId;
      selectedWebview.classList.add('cognitizer-browser');
      document.getElementById('cognitizer-container').appendChild(selectedWebview);
    }
    selectedWebview.src = config.baseUrls[currentCognitizerId]['url'];
    loadedCognitizers[currentCognitizerId] = true;
  }

  if (!multiCognition) {
    let options = document.querySelectorAll('.cognitizer-dropdown-section > div');
    options.forEach(option => {
      option.classList.remove('selected');
    });
    hideAllWebviews('#cognitizer-container');
  }

  document.getElementById(`${currentCognitizerId}button`).classList.add('selected');
  selectedWebview.classList.add('active');
  selectedWebview.classList.remove('inactive');
  selectedWebview.style.display = 'flex';

  if (multiCognition) {
    updateCognitizersLayout();
  }

  config.state.selectedCognitizer = currentCognitizerId;
  saveSettings(config);

  pauseInactiveResumeActiveCognitizer();
  focusWebview(currentCognitizerId);
}

function updateCognitizersLayout() {
  const activeCount = Object.values(activeCognitizers).filter(Boolean).length;
  if (activeCount === 0) return;

  const flexBasis = `${100 / activeCount}%`;
  const container = document.getElementById('cognitizer-container');
  const webviews = container.querySelectorAll('webview');

  webviews.forEach(webview => {
    if (activeCognitizers[webview.id]) {
      webview.style.flexBasis = flexBasis;
      webview.style.maxWidth = flexBasis;
    } else {
      webview.style.flexBasis = '0';
      webview.style.maxWidth = '0';
    }
  });
}

function selectURL(url) {
  // Get all webviews and hide them
  let webview_containers = document.querySelectorAll('#browser-container'); // Use '.' for class or '#' for id
  let webviews = [];
  webview_containers.forEach((container) => {
    let webviews_in_container = container.querySelectorAll('webview');
    webviews = [...webviews, ...webviews_in_container];
  });

  // Open the passed URL in the webview
  webviews.forEach(webview => {
    webview.src = url;
  });

  focusWebview('browser-webview');
}





function navigateBackCognitizer() {
  let activeWebview = document.querySelector('.cognitizer-browser.active');
  if (activeWebview && activeWebview.canGoBack()) {
    activeWebview.goBack();
  }
  focusWebview(currentCognitizerId);
}

function navigateForwardCognitizer() {
  let activeWebview = document.querySelector('.cognitizer-browser.active');
  if (activeWebview && activeWebview.canGoForward()) {
    activeWebview.goForward();
  }
  focusWebview(currentCognitizerId);
}

function refreshPageCognitizer() {
  let activeWebview = getActiveWebview();
  if (activeWebview) {
    activeWebview.reload();
  }
  focusWebview(currentCognitizerId);
}

// Convert a string like 'custom1' to it's index which would be 0
function getIndexFromId(id) {
  return parseInt(id.replace('custom', '')) - 1;
}

function navigateHomeCognitizer() {
  let activeWebview = document.querySelector('.cognitizer-browser.active');
  let cognitizerId = activeWebview.id;
  // Create a new webview instance
  let newWebview = document.createElement('webview');
  newWebview.id = cognitizerId;
  newWebview.classList.add('cognitizer-browser');
  newWebview.classList.add('active');
  newWebview.classList.remove('inactive');
  newWebview.src = config.baseUrls[getIndexFromId(cognitizerId)]['url'];
  newWebview.preload = path.join(__dirname, 'preload.js');

  // Replace the last webview instance
  let browserContainer = document.getElementById('cognitizer-container');
  browserContainer.replaceChild(newWebview, activeWebview);

  focusWebview(cognitizerId);
}

function navigateBackBrowser() {
  // Get all webviews and go back in history
  let webview_containers = document.querySelectorAll('#browser-container');
  let webviews = [];
  webview_containers.forEach((container) => {
    let webviews_in_container = container.querySelectorAll('webview');
    webviews = [...webviews, ...webviews_in_container];
  });

  webviews.forEach(webview => {
    if (webview.canGoBack()) {
      webview.goBack();
    }
  });
  focusWebview('browser-webview');
}

function navigateForwardBrowser() {
  // Get all webviews and go forward in history
  let webview_containers = document.querySelectorAll('#browser-container');
  let webviews = [];
  webview_containers.forEach((container) => {
    let webviews_in_container = container.querySelectorAll('webview');
    webviews = [...webviews, ...webviews_in_container];
  });

  webviews.forEach(webview => {
    if (webview.canGoForward()) {
      webview.goForward();
    }
  });
  focusWebview('browser-webview');
}

function refreshPageBrowser() {
  // Get all webviews and refresh them
  let webview_containers = document.querySelectorAll('#browser-container');
  let webviews = [];
  webview_containers.forEach((container) => {
    let webviews_in_container = container.querySelectorAll('webview');
    webviews = [...webviews, ...webviews_in_container];
  });

  webviews.forEach(webview => {
    webview.reload();
  });
  focusWebview('browser-webview');
}

function navigateHomeBrowser() {
  // Create a new webview instance
  let newWebview = document.createElement('webview');
  newWebview.id = 'browser-webview';
  newWebview.classList.add('web-browser');
  console.log(config);
  newWebview.src = config['settings']['browserHomeUrl'];
  newWebview.preload = path.join(__dirname, 'preload.js');

  // Replace the last webview instance
  let browserContainer = document.getElementById('browser-container');
  let oldWebview = browserContainer.querySelector('.web-browser');
  browserContainer.replaceChild(newWebview, oldWebview);

  // Focus the new webview
  focusWebview('browser-webview');
}



function pauseInactiveCognitizers() {
  try {
      let webviews = document.querySelectorAll('.cognitizer-browser.inactive');
      webviews.forEach(webview => {
          if (webview && webview.getWebContents) {
              const contents = webview.getWebContents();
              if (contents) {
                  contents.setBackgroundThrottling(false);
                  contents.pause();
              }
          }
      });
  } catch (error) {
      console.error('Error pausing inactive Cognitizers:', error);
  }
}

function resumeActiveCognitizer() {
  try {
      let webviews = document.querySelectorAll('.cognitizer-browser.active');
      webviews.forEach(webview => {
          if (webview && webview.getWebContents) {
              const contents = webview.getWebContents();
              if (contents) {
                  contents.setBackgroundThrottling(true);
                  contents.resume();
              }
          }
      });
  } catch (error) {
      console.error('Error pausing inactive Cognitizers:', error);
  }
}

function pauseInactiveResumeActiveCognitizer() {
  pauseInactiveCognitizers();
  resumeActiveCognitizer();
}


















// Event listeners to handle hover and mouse leave
let sideBar = document.getElementById('side-bar');
let menuContent = document.querySelector('.menu-content');

sideBar.addEventListener('mouseleave', (event) => {
  // Check if the cursor has left the sidebar and its contents
  if (!sideBar.contains(event.relatedTarget)) {
    collapseMenu();
  }
  // let activeWebview = document.querySelector('.cognitizer-browser.active');
  // focusWebview(currentCognitizerId);
});
menuContent.addEventListener('mouseleave', (event) => {
  // Check if the cursor has left the sidebar and its contents
  if (!sideBar.contains(event.relatedTarget)) {
    collapseMenu();
  }
  // let activeWebview = document.querySelector('.cognitizer-browser.active');
  // focusWebview(currentCognitizerId);
});



if (!browserViewActive) {
  document.getElementById('browser-view-option').textContent = '+';
} else {
  document.getElementById('browser-view-option').textContent = 'Browser View';
}

if (!cognitizerViewActive) {
  document.getElementById('cognitizer-view-option').textContent = '+';
} else {
  document.getElementById('cognitizer-view-option').textContent = 'Browser View';
}

document.getElementById('browser-container').classList.remove('active');
document.getElementById('browser-container').classList.add('inactive');
document.getElementById('cognitizer-container').style.flex = '1';
document.getElementById('browser-container').style.flex = '0';

function toggleView() {
  if (browserViewActive && !cognitizerViewActive) {
    toggleCognitizerView();
    toggleBrowserView();
  } else if (!browserViewActive && cognitizerViewActive) {
    toggleBrowserView();
    toggleCognitizerView();
  }
}

function resetView() {
  navigateHomeBrowser();
  navigateHomeCognitizer();
  toggleCognitizerView(true, false);
  toggleBrowserView(false, true);
}

function toggleBrowserView(only_show=false, only_hide=false) {
  if (browserViewActive && only_show) return;
  if (!browserViewActive && only_hide) return;

  if (only_show) {
    browserViewActive = true;
  } else {
    browserViewActive = !browserViewActive;
  }

  if (browserViewActive) {
    if (!sidebarExpanded) {
      document.getElementById('browser-view-option').textContent = '-';
    } else {
      document.getElementById('browser-view-option').textContent = 'Browser View';
    }
    document.getElementById('browser-container').classList.add('active');
    document.getElementById('browser-container').classList.remove('inactive');
    document.getElementById('browser-container').style.flex = '1';
    document.getElementById(`browser-view-option`).classList.add('selected');
  } else {
    if (!sidebarExpanded) {
      document.getElementById('browser-view-option').textContent = '+';
    } else {
      document.getElementById('browser-view-option').textContent = 'Browser View';
    }
    document.getElementById('browser-container').classList.remove('active');
    document.getElementById('browser-container').classList.add('inactive');
    document.getElementById('browser-container').style.flex = '0';
    document.getElementById(`browser-view-option`).classList.remove('selected');

    if (!cognitizerViewActive) {
      toggleCognitizerView(true); // Ensure cognitizer view is shown if browser view is hidden
    }
  }
}

function toggleCognitizerView(only_show=false, only_hide=false) {
  if (cognitizerViewActive && only_show) return;
  if (!cognitizerViewActive && only_hide) return;

  if (only_show) {
    cognitizerViewActive = true;
  } else {
    cognitizerViewActive = !cognitizerViewActive;
  }

  if (cognitizerViewActive) {
    if (!sidebarExpanded) {
      document.getElementById('cognitizer-view-option').textContent = '-';
    } else {
      document.getElementById('cognitizer-view-option').textContent = 'Cognitizer View';
    }
    document.getElementById('cognitizer-container').classList.add('active');
    document.getElementById('cognitizer-container').classList.remove('inactive');
    document.getElementById('cognitizer-container').style.flex = '1';
    document.getElementById(`cognitizer-view-option`).classList.add('selected');

    // Check if there are any active cognitizers when in multi-cognition mode
    if (multiCognition && Object.values(activeCognitizers).filter(Boolean).length === 0) {
      cognitizerViewActive = false;
      document.getElementById('cognitizer-container').style.flex = '0';
      document.getElementById('cognitizer-view-option').classList.remove('selected');
      if (!sidebarExpanded) {
        document.getElementById('cognitizer-view-option').textContent = '+';
      } else {
        document.getElementById('cognitizer-view-option').textContent = 'Cognitizer View';
      }
      toggleBrowserView(true);
    }

    // if no cognitizer is selected, select the last-selected one
    if (multiCognition) {
      if (Object.values(activeCognitizers).filter(Boolean).length === 0 || Object.values(activeCognitizers).includes(false)) {
        toggleBrowserView(only_show=true);
        selectCognitizer(currentCognitizerId);
      }
    }
  } else {
    if (!sidebarExpanded) {
      document.getElementById('cognitizer-view-option').textContent = '+';
    } else {
      document.getElementById('cognitizer-view-option').textContent = 'Cognitizer View';
    }
    document.getElementById('cognitizer-container').classList.remove('active');
    document.getElementById('cognitizer-container').classList.add('inactive');
    document.getElementById('cognitizer-container').style.flex = '0';
    document.getElementById(`cognitizer-view-option`).classList.remove('selected');

    if (!browserViewActive) {
      toggleBrowserView(true); // Ensure browser view is shown if cognitizer view is hidden
    }
  }
}



function toggleOpenLinkExternal() {
  openLinkExternal = !openLinkExternal;

  if (openLinkExternal) {
    document.getElementById(`open-link-external`).classList.add('selected');
  } else {
    document.getElementById(`open-link-external`).classList.remove('selected');
  }
  config.settings.openLinkExternal = openLinkExternal;
  saveSettings(config);
}

// Capture any ctrl + clicked link
ipcRenderer.on('open-url', (event, url) => {
  if (openLinkExternal) {
    shell.openExternal(url);
  } else {
    let secondWebview = document.getElementById('browser-webview');
    secondWebview.addEventListener('new-window', (e) => {
      e.preventDefault();
      shell.openExternal(e.url);
    });
    secondWebview.loadURL(url);
    toggleBrowserView(true); // Toggle browser view open to show the link
  }
});


function focusWebview(cognitizerId) {
  if (!cognitizerId) return; // Add null check
  selectCognitizerTextarea(cognitizerId);
}

function selectCognitizerTextarea() {
  let activeWebview = document.querySelector('.cognitizer-browser.active');
  if (!activeWebview) return; // Add null check
  
  try {
      activeWebview.focus();
      let textarea = activeWebview.querySelector('textarea');
      if (textarea) {
          textarea.select();
      }
  } catch (error) {
      console.error('Error focusing webview:', error);
  }
}

// window.addEventListener('focus', debounce(() => {
//   let activeWebview = document.querySelector('.cognitizer-browser.active');
//   focusWebview(currentCognitizerId);
// }, 10));




function printDebug(message) {
  // display the debug section and debug message
  let debugElement = document.getElementById('debug');
  if (typeof message === 'string') {
    debugElement.innerText = message;
  } else if (typeof message !== 'string') {
    debugElement.innerText = JSON.stringify(message);
  } else if (typeof message === 'number') {
    debugElement.innerText = String(message);
  } else if (typeof message === 'boolean') {
    debugElement.innerText = message ? 'true' : 'false';
  } else if (typeof message === 'object') {
    debugElement.innerText = JSON.stringify(message);
  } else if (typeof message === 'function') {
    debugElement.innerText = message.toString();
  } else if (typeof message === 'undefined') {
    debugElement.innerText = 'UNDEFINED';
  } else if (typeof message === 'symbol') {
    debugElement.innerText = message.toString();
  } else if (typeof message === 'bigint') {
    debugElement.innerText = message.toString();
  } else if (message instanceof Error) {
    debugElement.innerText = message.toString();
  }
  debugElement.style.display = 'flex';
}




// Function to load settings from the config file
function loadSettings() {
  try {
    let configData = null;
    if (os.platform() === 'darwin') {
      let userDataPath = path.join(os.homedir(), '.instant-cognition');
      let configPath = path.join(userDataPath, 'config.json');

      if (!fs.existsSync(userDataPath)) {
        fs.mkdirSync(userDataPath);
      }
  
      configData = fs.readFileSync(configPath, 'utf8');
    } else {
      configData = fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf8');
    }
    let loadedConfig = JSON.parse(configData);

    // Access the settings and populate the checkboxes
    let preventMenuExpansionCheckbox = document.getElementById('preventMenuExpansion');
    let enableAdblockerCheckbox = document.getElementById('enableAdblocker');
    let launchAtStartupCheckbox = document.getElementById('launchAtStartup');
    let enableDefaultCognitizerCheckbox = document.getElementById('enableDefaultCognitizer');
    let defaultCognitizerSelect = document.getElementById('defaultCognitizerSelect');

    // Initialize settings if they don't exist
    if (!loadedConfig.settings.preventMenuExpansion) {
      loadedConfig.settings.preventMenuExpansion = false;
    }
    if (!loadedConfig.settings.enableAdblocker) {
      loadedConfig.settings.enableAdblocker = false;
    }
    if (!loadedConfig.settings.launchAtStartup) {
      loadedConfig.settings.launchAtStartup = false;
    }
    if (!loadedConfig.settings.enableDefaultCognitizer) {
      loadedConfig.settings.enableDefaultCognitizer = false;
    }
    if (!loadedConfig.settings.defaultCognitizer) {
      loadedConfig.settings.defaultCognitizer = 'custom1';
    }
    if (!loadedConfig.settings.openLinkExternal) {
      loadedConfig.settings.openLinkExternal = false;
    }
    if(!loadedConfig.settings.browserHomeUrl) {
      loadedConfig.settings.browserHomeUrl = 'https://www.google.com/';
    }
    if (!loadedConfig.state) {
      loadedConfig.state = {};
    }
    if (!loadedConfig.state.selectedCognitizer) {
      loadedConfig.state.selectedCognitizer = defaultCognitizer;
    }
    if (!loadedConfig.state.windowBounds) {
      loadedConfig.state.windowBounds = { width: 1600, height: 900 };
    }
    if (!loadedConfig.baseUrls) {
      loadedConfig.baseUrls = baseUrls;
    }

    // If loadedConfig.baseUrls is a list, convert it to an object with 'custom1', 'custom2', etc. as keys
    if (Array.isArray(loadedConfig.baseUrls)) {
      let newBaseUrls = {};
      loadedConfig.baseUrls.forEach((url, index) => {
        newBaseUrls[`custom${index + 1}`] = url;
      });
      loadedConfig.baseUrls = newBaseUrls;
    }

    

    // Init loaded settings from config file
    if (preventMenuExpansionCheckbox) {
      preventMenuExpansionCheckbox.checked = loadedConfig.settings.preventMenuExpansion;
    }
    if (enableAdblockerCheckbox) {
      enableAdblockerCheckbox.checked = loadedConfig.settings.enableAdblocker;
    }
    if (launchAtStartupCheckbox) {
      launchAtStartupCheckbox.checked = loadedConfig.settings.launchAtStartup;
    }
    if (enableDefaultCognitizerCheckbox) {
      enableDefaultCognitizerCheckbox.checked = loadedConfig.settings.enableDefaultCognitizer;
    }
    if (defaultCognitizerSelect) {
      defaultCognitizerSelect.value = loadedConfig.settings.defaultCognitizer;
    }
    if (loadedConfig.settings.openLinkExternal) {
      document.getElementById('open-link-external').classList.add('selected');
      openLinkExternal = true;
    }
    
    saveSettings(loadedConfig);

    return loadedConfig;
  } catch (error) {
    console.error('Error loading settings:', error);
    // Return default settings
    return {
      settings: {
        preventMenuExpansion: false,
        enableAdblocker: false,
        launchAtStartup: false,
        enableDefaultCognitizer: false,
        defaultCognitizer: 'custom1',
        openLinkExternal: false,
        browserHomeUrl: 'https://www.google.com/'
      },
      state: {
        selectedCognitizer: defaultCognitizer,
        windowBounds: { width: 1600, height: 900 }
      },
      baseUrls: baseUrls
    };
  }
}

/**
 * Save Settings
 * applies the settings to the app and updates the configuration file
 * @param {} config - application's configuration
 */
function saveSettings(config) {
  // Convert the config.baseUrls object to an array in the order of custom1, custom2, custom3...custom15
  let currBaseUrls = [];
  Object.keys(config.baseUrls).forEach(key => {
    currBaseUrls.push(config.baseUrls[key]);
  });

  config.baseUrls = currBaseUrls;

  // Format JSON with indentation for better readability
  let configDataStr = JSON.stringify(config, null, 2);
  writeSettingsToFile(configDataStr);
}

function applySettings(settings){
  // Disable menu expand option
  let toggleButton = document.getElementById('toggle-button');
  if(settings.preventMenuExpansion) {
    toggleButton.removeEventListener('mouseover', expandMenu);
  } else {
    toggleButton.addEventListener('mouseover', expandMenu);
  }

  if (settings.enableAdblocker) {
    ipcRenderer.send('call-createAndUpdateaAblocker');
  } else {
    ipcRenderer.send('call-disableAdblocker');
  }

  if (settings.launchAtStartup) {
    ipcRenderer.invoke('call-isLaunchAtStartupEnabled').then((isEnabled) => {
      if (!isEnabled) {
        ipcRenderer.send('call-enableLaunchAtStartup');
      }
    }).catch((error) => {
      console.error('Error checking launch at startup:', error);
    });
  } else {
    ipcRenderer.invoke('call-isLaunchAtStartupEnabled').then((isEnabled) => {
      if (isEnabled) {
        ipcRenderer.send('call-disableLaunchAtStartup');
      }
    }).catch((error) => {
      console.error('Error checking launch at startup:', error);
    });
  }
}

function writeSettingsToFile(configDataStr){
  if (os.platform() === 'darwin') {
    let userDataPath = path.join(os.homedir(), '.instant-cognition');
    let configPath = path.join(userDataPath, 'config.json');

    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath);
    }

    fs.writeFileSync(configPath, configDataStr);
  } else {
    fs.writeFileSync(path.join(__dirname, '../../config.json'), configDataStr);
  }
}


// Add gesture event handling
function initializeGestureHandling() {
  const webviews = document.querySelectorAll('webview');
  webviews.forEach(webview => {
    webview.addEventListener('wheel', debounce(handleGesture, 10), { passive: true });
  });
}

function handleGesture(event) {
  if (event.deltaX !== 0 && Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
    if (event.deltaX > 0) {
      navigateBackActive();
    } else {
      navigateForwardActive();
    }
    event.preventDefault();
  }
}

function navigateBackActive() {
  const activeWebview = getActiveWebview();
  if (activeWebview && activeWebview.canGoBack()) {
    activeWebview.goBack();
  }
}

function navigateForwardActive() {
  const activeWebview = getActiveWebview();
  if (activeWebview && activeWebview.canGoForward()) {
    activeWebview.goForward();
  }
}

function refreshActive() {
  const activeWebview = getActiveWebview();
  if (activeWebview && activeWebview.canGoForward()) {
    activeWebview.reload();
  }
}

function navigateHomeActive() {
  if (lastBrowserInteraction > lastCognitizerInteraction) {
    navigateHomeBrowser();
  } else {
    navigateHomeCognitizer();
  }
}



// Set default Cognitizer to load on startup
document.addEventListener('DOMContentLoaded', () => {
  initializeFindBar();

  const webviews = document.querySelectorAll('webview');
  webviews.forEach(webview => {
    webview.addEventListener('dom-ready', () => {
      webview.executeJavaScript(`
        document.addEventListener('click', (e) => {
          window.lastClickY = e.pageY;
        });
      `);
    });
  });

  // Initialize pressed cognitizer view button
  document.getElementById(`cognitizer-view-option`).classList.add('selected');
  document.getElementById('cognitizer-view-option').textContent = '-';

  initializeFindEvents();

  applySettings(config.settings);

  // Get the number of baseUrls
  const baseUrlsLength = Object.keys(config.baseUrls).length;
  removeExcessCognitizerButtons(baseUrlsLength);

  let options_dropdown = document.querySelectorAll('.cognitizer-dropdown-section > div');
  options_dropdown.forEach(option => {
    let idWithoutButton = option.id.replace('button', '');
    
    option.textContent = config.baseUrls[idWithoutButton]['name'];
    fullNames[idWithoutButton] = option.textContent;
  });

  // Initialize the loaded cognitizers
  Object.keys(config.baseUrls).forEach(key => {
    loadedCognitizers[key] = false;
  });

  // Initialize the src for the web-browser webview
  let webview = document.querySelector('.web-browser');
  webview.src = config['browserHomeUrl'];

  findInput = document.getElementById('find-input');
  // Add event listener to select all text when clicking into the input
  findInput.addEventListener('click', (e) => {
    e.target.select();
  });
 
  initializeGestureHandling();

  selectURL(config.browserHomeUrl);
  try {
    selectCognitizer(config.state.selectedCognitizer);
  } catch (error) {
    console.error('Error selecting cognitizer: ', error);
    selectCognitizer('custom1');
  }

  // Initialize the collapsed menu icons
  let options = document.querySelectorAll('.dropdown-section > div');
  setCollapsedMenuIcons(options);
  initializeCheckboxes();
});



// Add these event listeners
ipcRenderer.on('navigate-back', () => {
  navigateBackActive();
});

ipcRenderer.on('navigate-forward', () => {
  navigateForwardActive();
});

ipcRenderer.on('navigate-refresh', () => {
  refreshActive();
});

ipcRenderer.on('navigate-home', () => {
  navigateHomeActive();
});

ipcRenderer.on('closeBrowser', () => {
  navigateHomeBrowser();
  toggleBrowserView(false, true);
});

ipcRenderer.on('toggleView', () => {
  toggleView();
});

ipcRenderer.on('resetView', () => {
  resetView();
});


function changeSetting(checked, setting) {
  // printDebug('Setting: ' + setting + ' changed to: ' + checked);
  config.settings[setting] = checked;
  saveSettings(config);
  applySettings(config.settings);
} 






// Variable to keep track of the current search term
let currentFindTerm = '';
let findInPageRequestId = 0;

// ipcRenderer.on('show-find-bar', () => {
//   toggleFindBar();
// });

function toggleMultiCognition() {
  multiCognition = !multiCognition;

  if (multiCognition) {
    document.getElementById(`toggle-multi-cognition`).classList.add('selected');
  } else {
    document.getElementById(`toggle-multi-cognition`).classList.remove('selected');
    
    // When disabling multi-cognition:
    // 1. Keep track of which cognitizer was last active
    const lastActive = currentCognitizerId;
    
    // 2. Reset all active cognitizers
    Object.keys(activeCognitizers).forEach(key => {
      activeCognitizers[key] = false;
      const webview = document.getElementById(key);
      if (webview) {
        webview.style.display = 'none';
        webview.classList.remove('active');
        webview.classList.add('inactive');
      }
    });

    // 3. Ensure Cognitizer view is active
    toggleCognitizerView(true);

    // 4. Select and show the last active cognitizer
    selectCognitizer(lastActive, true);

    // 5. Reset the layout
    const container = document.getElementById('cognitizer-container');
    const webviews = container.querySelectorAll('webview');
    webviews.forEach(webview => {
      webview.style.flexBasis = '100%';
      webview.style.maxWidth = '100%';
    });

    selectCognitizer(lastActive);
  }

  // Update the layout if still in multi-cognition mode
  if (multiCognition) {
    updateCognitizersLayout();
  }
}

function toggleFindBar() {
  const findBar = document.getElementById('find-bar');

  if (!findBar) {
    createFindBar();
  } else {
    if (findBar.style.display === 'flex') {
      document.getElementById(`toggle-find-bar`).classList.remove('selected');
      closeFindBar();
      stopFindInPage();
      return;
    }
  }
  document.getElementById(`toggle-find-bar`).classList.add('selected');

  findBar.style.display = 'flex';

  findInput = document.getElementById('find-input');

  findInput.focus();
  findInput.select();

  // get currentFindTerm from the text that's already in the input
  findInput.addEventListener('input', debounce((e) => {
    currentFindTerm = findInput.value;
    if (currentFindTerm) {
      startFindInPage(currentFindTerm);
    } else {
      stopFindInPage('clearSelection');
    }
  }, 100));
  findInPage('forward');
}

function initializeFindBar() {
  createFindBar();
  toggleFindBar();
  toggleFindBar();

  // Add global keydown listener to handle Escape key
  ipcRenderer.on('close-find-bar', () => {
    document.getElementById(`toggle-find-bar`).classList.remove('selected');
    closeFindBar();
    stopFindInPage();
  });
}

function createFindBar() {
  // Create the find bar elements
  const findBar = document.createElement('div');
  findBar.id = 'find-bar';

  findBar.innerHTML = `
    <input type="text" id="find-input" placeholder="Find in page">
    <span id="find-results-count"></span>
    <button id="find-prev">▲</button>
    <button id="find-next">▼</button>
    <button id="find-close">✖</button>
  `;

  document.body.appendChild(findBar);

  // Add styles for the find bar
  const styles = document.createElement('style');
  styles.innerHTML = `
    #find-bar {
      position: fixed;
      top: 0;
      width: 35%;
      right: 45%;
      left: 20%;
      height: 35px;
      background-color: #333;
      color: #fff;
      display: flex;
      align-items: center;
      padding: 5px;
      z-index: 1000;
    }
    #find-bar input {
      flex: 1;
      margin-right: 5px;
      height: 25px;
      padding: 5px;
      background-color: #555;
      color: #fff;
      border: 1px solid #444;
    }
    #find-bar button {
      margin-left: 5px;
      height: 30px;
      background-color: #555;
      color: #fff;
      border: 1px solid #444;
    }
    #find-results-count {
      margin-left: 1px;
      margin-right: 1px;
      font-size: 14px;
      min-width: 80px; /* Added to ensure space for count */
      text-align: center; /* Center the text */
      white-space: nowrap; /* Prevent text wrapping */
    }
  `;
  document.head.appendChild(styles);

  const findInput = document.getElementById('find-input');
  const findNext = document.getElementById('find-next');
  const findPrev = document.getElementById('find-prev');
  const findClose = document.getElementById('find-close');

  // Handle input changes with debouncing
  findInput.addEventListener('input', debounce((e) => {
    currentFindTerm = e.target.value;
    if (currentFindTerm) {
      startFindInPage(currentFindTerm);
    } else {
      stopFindInPage('clearSelection');
    }
  }, 100));

  // Handle Enter and Escape key events
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      findInPage('forward');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      document.getElementById(`toggle-find-bar`).classList.remove('selected');
      closeFindBar();
      stopFindInPage();
    }
  });

  // Find next occurrence
  findNext.addEventListener('click', () => {
    findInPage('forward');
  });

  // Find previous occurrence
  findPrev.addEventListener('click', () => {
    findInPage('backward');
  });

  // Close the find bar
  findClose.addEventListener('click', () => {
    closeFindBar();
  });
}

// Add an event listener for found-in-page events on webviews
function initializeFindEvents() {
  const webviews = document.querySelectorAll('webview');
  webviews.forEach((webview) => {
    webview.addEventListener('found-in-page', handleFoundInPage);
  });
}

function handleFoundInPage(event) {
  const result = event.result;
  const findResultsCount = document.getElementById('find-results-count');
  if (findResultsCount) {
    if (result.finalUpdate) {
      updateFindResultsCount(result.activeMatchOrdinal, result.matches);
    }
  }
}

function updateFindResultsCount(activeMatchOrdinal, matches) {
  const findResultsCount = document.getElementById('find-results-count');
  if (findResultsCount) {
    if (matches > 0) {
      findResultsCount.textContent = `${activeMatchOrdinal} of ${matches}`;
    } else {
      findResultsCount.textContent = '';
    }
  }
}

function startFindInPage(text) {
  const activeWebview = getActiveWebview();
  if (!activeWebview || !text) return;

  clearTimeout(findInPageTimeout);

  findInPageTimeout = setTimeout(() => {
    try {
      activeWebview.stopFindInPage('clearSelection');
      
      if (text.length > 0) {
        findInPageRequestId++;
        activeWebview.findInPage(text, {
          forward: true,
          findNext: false,
          matchCase: false,
          requestId: findInPageRequestId,
        });
      }
    } catch (error) {
      console.error('Error in find in page:', error);
    }
  }, 50); // Increased debounce time to prevent freezing
}

// Declare a timeout variable to debounce the find operation
let findInPageTimeout;

// Add debounced version of findInPage
const debouncedFindInPage = debounce((direction) => {
  const activeWebview = getActiveWebview();
  if (activeWebview && currentFindTerm) {
    findInPageRequestId++;
    activeWebview.findInPage(currentFindTerm, {
      forward: direction === 'forward', 
      findNext: true,
      requestId: findInPageRequestId
    });
  }
}, 10); // 10ms debounce time

// Update the findInPage function to use the debounced version
function findInPage(direction) {
  debouncedFindInPage(direction);
}

function stopFindInPage() {
  const activeWebview = getActiveWebview();
  if (activeWebview && activeWebview.isReady) {
    activeWebview.stopFindInPage('clearSelection');
  }
}

function closeFindBar() {
  stopFindInPage();
  const findBar = document.getElementById('find-bar');
  if (findBar) {
    findBar.style.display = 'none';
  }
  currentFindTerm = '';
  updateFindResultsCount(0, 0);
}

// Add tracking variables at module scope
let lastCognitizerInteraction = 0;
let lastBrowserInteraction = 0;

// Add event listeners to track interactions
function initWebviewTracking() {
    // Initial setup for existing webviews
    attachWebviewListeners();

    // Create an observer to watch for new webviews
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.classList?.contains('cognitizer-browser') || 
                    node.classList?.contains('web-browser')) {
                    attachListenersToWebview(node);
                }
            });
        });
    });

    // Start observing the containers for changes
    observer.observe(document.getElementById('cognitizer-container'), { 
        childList: true,
        subtree: true 
    });
    observer.observe(document.getElementById('browser-container'), { 
        childList: true,
        subtree: true 
    });
}

function attachWebviewListeners() {
    // Attach to cognitizer webviews
    document.querySelectorAll('.cognitizer-browser').forEach(cognitizerWebview => {
        attachListenersToWebview(cognitizerWebview);
    });

    // Attach to browser webview
    const browserWebview = document.querySelector('.web-browser');
    if (browserWebview) {
        attachListenersToWebview(browserWebview);
    }
}

function attachListenersToWebview(webview) {
  if (!webview || webview._hasTracking) return;

  const isCognitizer = webview.classList.contains('cognitizer-browser');
  
  const updateTime = () => {
    if (isCognitizer) {
      lastCognitizerInteraction = Date.now();
      // Update currentCognitizerId when entering a cognitizer webview
      currentCognitizerId = webview.id;
    } else {
      lastBrowserInteraction = Date.now();
    }
    lastActiveWebview = webview;
  };

  webview.addEventListener('mouseenter', updateTime);
  webview.addEventListener('click', updateTime);
  webview.addEventListener('focus', updateTime);
  webview.addEventListener('dom-ready', () => {
    webview.isReady = true;
  });
  webview._hasTracking = true;
}

// Add variable to store last active webview
let lastActiveWebview = null;

function getActiveWebview() {
  if (lastActiveWebview) {
    return lastActiveWebview;
  }

  // Fallback to previous behavior if no webview is tracked
  const cognitizerWebviews = document.querySelectorAll('.cognitizer-browser');
  const browserWebview = document.querySelector('.web-browser');

  if (lastBrowserInteraction > lastCognitizerInteraction) {
    return browserWebview;
  }

  return Array.from(cognitizerWebviews).find(webview => webview.classList.contains('active')) || null;
}

// Initialize tracking on load
initWebviewTracking();

function initializeCheckboxes() {
  const checkboxSettings = {
    'preventMenuExpansion': document.getElementById('preventMenuExpansion'),
    'enableAdblocker': document.getElementById('enableAdblocker'),
    'launchAtStartup': document.getElementById('launchAtStartup'),
    'enableDefaultCognitizer': document.getElementById('enableDefaultCognitizer')
  };

  // Set initial checkbox states based on config
  Object.entries(checkboxSettings).forEach(([setting, checkbox]) => {
    if (checkbox) {
      checkbox.checked = config.settings[setting];
      checkbox.addEventListener('change', (e) => changeSetting(e.target.checked, setting));
    }
  });
}

function removeExcessCognitizerButtons(baseUrlsLength) {
  for (let i = 15; i > baseUrlsLength; i--) {
    const buttonId = `custom${i}button`;
    const button = document.getElementById(buttonId);
    if (button) {
      button.remove();
    }
  }
}
