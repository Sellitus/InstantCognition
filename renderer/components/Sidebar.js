let ipcRenderer;
try {
  ({ ipcRenderer } = require('electron'));
} catch (e) {
  // Running in test environment
  ipcRenderer = { send: () => {}, on: () => {} };
}

class Sidebar {
  constructor() {
    this.element = null;
    this.toggleButton = null;
    this.menuContent = null;
    this.isExpanded = false;
    this.preventExpansion = false;
    this.expandTimeout = null;
    this.ripples = new Map();
    
    // Bind the mouseenter handler so we can properly add/remove it
    this.handleMouseEnter = () => {
      clearTimeout(this.expandTimeout);
      this.expandTimeout = setTimeout(() => this.expand(), 100);
    };
  }

  initialize(config) {
    this.element = document.getElementById('side-bar');
    this.toggleButton = document.getElementById('toggle-button');
    this.menuContent = document.querySelector('.menu-content');
    this.preventExpansion = config.settings.preventMenuExpansion || false;
    
    this.setupEventListeners();
    this.setupDropdownSections();
    this.updateButtonStates();
  }

  setupEventListeners() {
    // Toggle button click
    this.toggleButton.addEventListener('click', (e) => {
      this.createRipple(e, this.toggleButton);
      if (e.target.closest('#toggle-button')) {
        ipcRenderer.send('toggle-settings-menu');
      }
    });

    // Hover expand/collapse
    if (!this.preventExpansion) {
      this.toggleButton.addEventListener('mouseenter', this.handleMouseEnter);
    }

    this.element.addEventListener('mouseleave', (event) => {
      clearTimeout(this.expandTimeout);
      if (!this.element.contains(event.relatedTarget)) {
        this.collapse();
      }
    });

    // Add ripple effect to all buttons
    this.element.querySelectorAll('.dropdown-section > div').forEach(button => {
      button.addEventListener('click', (e) => this.createRipple(e, button));
    });
  }

  setupDropdownSections() {
    // Add smooth scroll behavior to menu content
    this.menuContent.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.menuContent.scrollBy({
        top: e.deltaY,
        behavior: 'smooth'
      });
    });

    // Add specific scroll handling for cognitizer section
    const cognitizerSection = this.element.querySelector('.cognitizer-dropdown-section');
    if (cognitizerSection) {
      this.setupCognitizerScrolling(cognitizerSection);
    }

    // Add intersection observer for scroll animations
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
        }
      });
    }, {
      root: this.menuContent,
      threshold: 0.1
    });

    this.menuContent.querySelectorAll('.dropdown-section > div').forEach(item => {
      observer.observe(item);
    });
  }

  setupCognitizerScrolling(cognitizerSection) {
    let scrollTimeout;

    // Add visual feedback during scrolling
    const addScrollingClass = () => {
      cognitizerSection.classList.add('scrolling');
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        cognitizerSection.classList.remove('scrolling');
      }, 150);
    };

    // Use native browser scrolling for the best touchpad/mouse wheel experience
    // Just prevent the parent menu from scrolling when scrolling within cognitizer section
    cognitizerSection.addEventListener('wheel', (e) => {
      // Only stop propagation to prevent parent scrolling, but let browser handle the scroll naturally
      e.stopPropagation();
      
      // Add visual feedback
      addScrollingClass();
    }, { passive: true });

    // Add scroll event listener for visual feedback
    cognitizerSection.addEventListener('scroll', () => {
      addScrollingClass();
    }, { passive: true });

    // Keyboard navigation support (keep this for accessibility)
    cognitizerSection.addEventListener('keydown', (e) => {
      const scrollAmount = 50;
      
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          cognitizerSection.scrollBy({
            top: -scrollAmount,
            behavior: 'smooth'
          });
          break;
        case 'ArrowDown':
          e.preventDefault();
          cognitizerSection.scrollBy({
            top: scrollAmount,
            behavior: 'smooth'
          });
          break;
        case 'PageUp':
          e.preventDefault();
          cognitizerSection.scrollBy({
            top: -cognitizerSection.clientHeight * 0.8,
            behavior: 'smooth'
          });
          break;
        case 'PageDown':
          e.preventDefault();
          cognitizerSection.scrollBy({
            top: cognitizerSection.clientHeight * 0.8,
            behavior: 'smooth'
          });
          break;
        case 'Home':
          e.preventDefault();
          cognitizerSection.scrollTo({
            top: 0,
            behavior: 'smooth'
          });
          break;
        case 'End':
          e.preventDefault();
          cognitizerSection.scrollTo({
            top: cognitizerSection.scrollHeight,
            behavior: 'smooth'
          });
          break;
      }
    });

    // Make the cognitizer section focusable for keyboard navigation
    cognitizerSection.setAttribute('tabindex', '0');
  }

  expand() {
    if (this.isExpanded) return;
    
    this.element.classList.add('expanded', 'animating');
    this.isExpanded = true;
    
    // Update button text/icons
    this.updateExpandedState();
    
    // Remove animation class after transition
    setTimeout(() => {
      this.element.classList.remove('animating');
    }, 200);
  }

  collapse() {
    if (!this.isExpanded) return;
    
    this.element.classList.remove('expanded');
    this.element.classList.add('animating');
    this.isExpanded = false;
    
    // Update button text/icons
    this.updateCollapsedState();
    
    // Remove animation class after transition
    setTimeout(() => {
      this.element.classList.remove('animating');
    }, 200);
  }

  updateExpandedState() {
    this.toggleButton.innerHTML = '<span class="settings-text">Settings</span>';
    
    // Update all menu items to show full text
    const options = this.element.querySelectorAll('.dropdown-section > div');
    options.forEach(option => {
      const id = option.id.replace('button', '');
      const fullName = window.fullNames[id];
      if (fullName) {
        option.textContent = fullName;
      }
    });
  }

  updateCollapsedState() {
    this.toggleButton.innerHTML = '<img src="./assets/icon.png" class="collapsed-menu-logo-instant-cognition">';
    
    // Update all menu items to show icons/abbreviations
    const options = this.element.querySelectorAll('.dropdown-section > div');
    window.setCollapsedMenuIcons(options);
  }

  createRipple(event, element) {
    // Clean up old ripples
    const existingRipple = this.ripples.get(element);
    if (existingRipple) {
      existingRipple.remove();
      this.ripples.delete(element);
    }

    const ripple = document.createElement('span');
    ripple.classList.add('ripple');
    
    const rect = element.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = event.clientX - rect.left - size / 2;
    const y = event.clientY - rect.top - size / 2;
    
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = x + 'px';
    ripple.style.top = y + 'px';
    
    element.appendChild(ripple);
    this.ripples.set(element, ripple);
    
    // Force reflow
    ripple.offsetHeight;
    
    ripple.classList.add('animate');
    
    // Remove ripple after animation
    setTimeout(() => {
      ripple.remove();
      this.ripples.delete(element);
    }, 600);
  }

  updateButtonStates() {
    // Update selected states based on current view
    const updateButton = (id, isActive) => {
      const button = document.getElementById(id);
      if (button) {
        if (isActive) {
          button.classList.add('selected');
        } else {
          button.classList.remove('selected');
        }
      }
    };

    // This will be called from the main renderer when states change
    this.updateButton = updateButton;
  }

  highlightButton(buttonId, duration = 1000) {
    const button = document.getElementById(buttonId);
    if (!button) return;
    
    button.classList.add('highlight');
    setTimeout(() => {
      button.classList.remove('highlight');
    }, duration);
  }

  showTooltip(element, text) {
    if (this.isExpanded) return;
    
    const tooltip = document.createElement('div');
    tooltip.className = 'sidebar-tooltip';
    tooltip.textContent = text;
    
    const rect = element.getBoundingClientRect();
    tooltip.style.top = rect.top + rect.height / 2 + 'px';
    tooltip.style.left = rect.right + 10 + 'px';
    
    document.body.appendChild(tooltip);
    
    // Force reflow
    tooltip.offsetHeight;
    tooltip.classList.add('visible');
    
    const removeTooltip = () => {
      tooltip.classList.remove('visible');
      setTimeout(() => tooltip.remove(), 200);
      element.removeEventListener('mouseleave', removeTooltip);
      element.removeEventListener('click', removeTooltip);
    };
    
    element.addEventListener('mouseleave', removeTooltip);
    element.addEventListener('click', removeTooltip);
  }

  addDragAndDrop() {
    let draggedElement = null;
    
    const cognitizerButtons = this.element.querySelectorAll('.cognitizer-dropdown-section > div');
    
    cognitizerButtons.forEach(button => {
      button.draggable = true;
      
      button.addEventListener('dragstart', (e) => {
        draggedElement = button;
        button.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/html', button.innerHTML);
      });
      
      button.addEventListener('dragend', () => {
        button.classList.remove('dragging');
      });
      
      button.addEventListener('dragover', (e) => {
        e.preventDefault();
        const draggingOver = document.querySelector('.dragging-over');
        if (draggingOver && draggingOver !== button) {
          draggingOver.classList.remove('dragging-over');
        }
        button.classList.add('dragging-over');
      });
      
      button.addEventListener('dragleave', () => {
        button.classList.remove('dragging-over');
      });
      
      button.addEventListener('drop', (e) => {
        e.preventDefault();
        button.classList.remove('dragging-over');
        
        if (draggedElement && draggedElement !== button) {
          // Swap the elements
          const parent = button.parentNode;
          const draggedNext = draggedElement.nextSibling;
          const buttonNext = button.nextSibling;
          
          parent.insertBefore(draggedElement, buttonNext);
          parent.insertBefore(button, draggedNext);
          
          // Emit reorder event
          this.onCognitizerReorder();
        }
      });
    });
  }

  onCognitizerReorder() {
    // Get new order and save to config
    const newOrder = [];
    this.element.querySelectorAll('.cognitizer-dropdown-section > div').forEach(button => {
      const id = button.id.replace('button', '');
      newOrder.push(id);
    });
    
    // Emit event to save new order
    ipcRenderer.send('reorder-cognitizers', newOrder);
  }

  setPreventExpansion(prevent) {
    this.preventExpansion = prevent;
    if (prevent) {
      // Remove the mouseenter listener when preventing expansion
      this.toggleButton.removeEventListener('mouseenter', this.handleMouseEnter);
    } else {
      // Add the mouseenter listener when allowing expansion
      this.toggleButton.addEventListener('mouseenter', this.handleMouseEnter);
    }
  }
}

// Create singleton instance
const sidebar = new Sidebar();

module.exports = sidebar;