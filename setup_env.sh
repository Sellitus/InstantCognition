# CD into the directory of this script
cd "$(dirname "$0")" || exit 1



if [[ "$(uname)" == "Darwin" ]]; then
    
    echo ""
    echo ":: MacOS detected, setting up environment"
    echo ""

    # Check if brew is installed, if it isn't, install it
    if ! command -v brew &> /dev/null; then
        echo ""
        echo ":: Installing Homebrew"
        echo ""

        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    fi

    brew update
    brew upgrade

    brew install node

    npm install npm@latest
    npm install -g npm-check-updates

    npm update

    echo ""
    echo ""
    echo ":: Run the following command to complete setup: source ~/.zshrc"
    echo ""
    echo ""

else

    echo ""
    echo ":: Ubuntu detected, setting up environment"
    echo ""


    sudo apt update


    sudo apt -y install libnss3
    sudo apt -y install wine
    sudo apt -y install rar
    sudo apt -y install hfsprogs
    sudo apt -y install dmg2img
    sudo apt -y install util-linux
    sudo apt -y install zip
    sudo apt -y install libatomic1

    sudo apt -y purge nodejs
    sudo apt -y purge npm
    

    sudo apt autoremove



    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -

    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.3/install.sh | bash



    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
    [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion

    source ~/.bashrc

    npm install npm@latest

    nvm install --latest-npm

    npm install -g npm-check-updates


    alias nodejs=node
    echo "alias nodejs=node" >> ~/.bashrc

    echo ""
    echo ""
    echo ":: Run the following command to complete setup: source ~/.bashrc"
    echo ""
    echo ""
fi



# Full Install Command: npm install electron-packager os
npm ci
