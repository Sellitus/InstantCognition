#!/bin/bash
if [ "$EUID" -eq 0 ]; then
    echo "This script should not be run with sudo."
    exit 1
fi

# CD into the directory of this script
cd "$(dirname "$0")" || exit 1

# Auto-detect if no arguments provided
if [ $# -eq 0 ]; then
    # Detect platform
    if [[ "$OSTYPE" == "darwin"* ]]; then
        platform="mac"
    elif grep -qEi "(Microsoft|WSL)" /proc/version &> /dev/null; then
        platform="win"
    else
        echo "Unsupported platform detected: $OSTYPE"
        exit 1
    fi

    # Detect architecture
    machine=$(uname -m)
    case "$machine" in
        arm64|aarch64) architecture="arm" ;;
        x86_64|amd64) architecture="x64" ;;
        *) 
            echo "Unsupported architecture detected: $machine"
            exit 1
            ;;
    esac

    # Get Windows username if on Windows
    if [ "$platform" == "win" ]; then
        windows_user=$(cmd.exe /c "echo %USERNAME%" 2>/dev/null | tr -d '\r')
    fi

    echo "--- Detected platform: $platform"
    echo "Detected architecture: $architecture"
    [ "$platform" == "win" ] && echo "Detected Windows user: $windows_user"

# Handle manual arguments
elif [ $# -ne 3 ] && [ $# -ne 2 ]; then
    echo "Usage for Windows: $0 <platform> <architecture> <windows_user>"
    echo "Example: $0 win x64 selli"
    echo "Usage for MacOS: $0 <platform> <architecture>"
    echo "Example: $0 mac arm"
    exit 1
else
    if [ $# -eq 2 ]; then
        platform=$1
        architecture=$2
        windows_user=""
    else
        platform=$1
        architecture=$2
        windows_user=$3
    fi
fi



if [ "$platform" != "win" ] && [ "$platform" != "mac" ]; then
    echo "Invalid platform. Please provide 'win' or 'mac' as the first argument."
    exit 1
fi

if [ "$architecture" != "arm" ] && [ "$architecture" != "x64" ]; then
    echo "Invalid architecture. Please provide 'arm' or 'x64' as the second argument."
    exit 1
fi


if [ "$platform" == "win" ]; then
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" # Load nvm

    nvm install --latest-npm

    npm install -g npm-check-updates
fi


script_start_time=$(date +%s)



echo ""
echo ":: Installing NPM packages"
echo ""

# Install with legacy peer deps to avoid conflicts
npm install --legacy-peer-deps

# Only update if explicitly requested
if [ "$UPDATE_PACKAGES" = "true" ]; then
    echo ""
    echo ":: Updating all NPM packages"
    echo ""
    bash update_packages_latest.sh
fi



echo ""
echo ":: Building CSS files"
echo ""

node scripts/build-css.js

echo ""
echo ":: Building the app"
echo ""

rm -rf builds/*

npm run package-$platform-$architecture



end_time=$(date +%s)
execution_time=$((end_time - script_start_time))
echo ""
echo ":: Build app execution time: $(($execution_time / 60)) minutes and $(($execution_time % 60)) seconds."
echo ""

copy_start_time=$(date +%s)




if [ "$platform" == "win" ]; then
    echo ""
    echo ":: Detecting Desktop location for Windows user: $windows_user"
    
    # Check if Desktop is in OneDrive
    onedrive_desktop="/mnt/c/Users/$windows_user/OneDrive/Desktop"
    regular_desktop="/mnt/c/Users/$windows_user/Desktop"
    
    if [ -d "$onedrive_desktop" ]; then
        desktop_path="$onedrive_desktop"
        echo ":: Found OneDrive Desktop at: $desktop_path"
    elif [ -d "$regular_desktop" ]; then
        desktop_path="$regular_desktop"
        echo ":: Found regular Desktop at: $desktop_path"
    else
        echo ":: Warning: Could not find Desktop folder, using default location"
        desktop_path="$regular_desktop"
    fi
    
    echo ":: Copying the app to: $desktop_path/InstantCognition/"
    echo ""

    mkdir -p "$desktop_path/InstantCognition/"

    # Kill any running instances
    echo ":: Closing any running instances of InstantCognition..."
    /mnt/c/Windows/System32/taskkill.exe /F /IM "InstantCognition.exe" 2>&1 | grep -v "ERROR: The process" || true
    sleep 5
    
    # Copy with force flag (overwrite existing files)
    echo ":: Copying application files..."
    cp -rf builds/$platform-$architecture/* "$desktop_path/InstantCognition/"
    
    # Copy any .bat files that were created
    subfolder_architecture=$(if [[ "$architecture" == "arm" ]]; then echo "arm64"; else echo "x64"; fi)
    if ls builds/$platform-$architecture/InstantCognition-win32-$subfolder_architecture/*.bat 1> /dev/null 2>&1; then
        cp builds/$platform-$architecture/InstantCognition-win32-$subfolder_architecture/*.bat "$desktop_path/InstantCognition/InstantCognition-win32-$subfolder_architecture/"
        echo ":: Copied launcher scripts"
    fi
    
    # Launch the app on Windows
    echo ""
    echo ":: Launching InstantCognition on Windows..."
    
    # Create a batch file launcher to set the correct working directory
    if [ -f "$desktop_path/InstantCognition/InstantCognition-win32-$subfolder_architecture/InstantCognition.exe" ]; then
        # Create launcher batch file
        launcher_path="$desktop_path/InstantCognition/launch.bat"
        echo "@echo off" > "$launcher_path"
        echo "cd /d \"%~dp0InstantCognition-win32-$subfolder_architecture\"" >> "$launcher_path"
        echo "start \"\" \"InstantCognition.exe\"" >> "$launcher_path"
        echo "exit" >> "$launcher_path"
        
        # Convert launcher path to Windows format
        windows_launcher=$(wslpath -w "$launcher_path")
        echo ":: Created launcher at: $windows_launcher"
        echo ":: Launching InstantCognition..."
        
        # Execute the launcher in a detached process
        (cd /mnt/c && /mnt/c/Windows/System32/cmd.exe /c "$windows_launcher" > /dev/null 2>&1) &
    else
        echo ":: Error: InstantCognition.exe not found at expected location"
        echo ":: Please check if the copy operation completed successfully"
    fi
else # platform == "mac"
    echo ""
    echo ":: Detecting Applications folder for macOS"
    
    # Check for user Applications folder first, then system
    user_apps="$HOME/Applications"
    system_apps="/Applications"
    
    if [ -d "$user_apps" ] && [ -w "$user_apps" ]; then
        apps_path="$user_apps"
        echo ":: Found user Applications folder at: $apps_path"
    elif [ -w "$system_apps" ]; then
        apps_path="$system_apps"
        echo ":: Using system Applications folder at: $apps_path"
    else
        # Fallback to creating user Applications if neither exists
        apps_path="$user_apps"
        mkdir -p "$apps_path"
        echo ":: Created user Applications folder at: $apps_path"
    fi
    
    echo ":: Copying the app to: $apps_path/InstantCognition.app"
    echo ""

    osascript -e 'quit app "InstantCognition.app"'

    # set subfolder to arm64 if $architecture is 'arm', else set it to x64
    subfolder_architecture=$(if [[ "$architecture" == "arm" ]]; then echo "arm64"; else echo "x64"; fi)

    cp -r builds/mac-$architecture/InstantCognition-darwin-$subfolder_architecture/InstantCognition.app "$apps_path/"
    
    # Launch the app on macOS
    echo ""
    echo ":: Launching InstantCognition on macOS..."
    if command -v open &> /dev/null; then
        open "$apps_path/InstantCognition.app"
    else
        echo ":: Note: 'open' command not available. Please launch InstantCognition.app manually from $apps_path"
    fi
fi



end_time=$(date +%s)
execution_time=$((end_time - copy_start_time))
echo ""
echo ":: Copy app execution time: $(($execution_time / 60)) minutes and $(($execution_time % 60)) seconds."
echo ""



execution_time=$((end_time - script_start_time))
# Print the execution time in an aesthetically pleasing way
echo ""
echo ""
echo ":: Full script execution time: $(($execution_time / 60)) minutes and $(($execution_time % 60)) seconds."
echo ""

echo ""
echo ":: Build process complete!"
echo ""
